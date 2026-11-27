from __future__ import annotations

import base64
import binascii
from concurrent.futures import ThreadPoolExecutor, wait
from contextlib import closing
import ctypes
import hashlib
import gzip
from html import escape as html_escape
import hmac
import ipaddress
import json
import logging
import os
import re
import secrets
import socket
import sqlite3
import ssl
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import truststore
import webview
from cryptography import x509
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

try:
    from zeroconf import IPVersion, ServiceBrowser, ServiceInfo, ServiceListener, Zeroconf
    HAVE_ZEROCONF = True
except ImportError:
    ServiceListener = object
    HAVE_ZEROCONF = False

try:
    import qrcode
    import qrcode.image.svg
    HAVE_QRCODE = True
except ImportError:
    HAVE_QRCODE = False


APP_NAME = "CRAS-Desktop"
GITHUB_REPOSITORY = "crasOP-dev/cras-desktop-updates"
GITHUB_RELEASES_API = f"https://api.github.com/repos/{GITHUB_REPOSITORY}/releases/latest"
UPDATE_ASSET_NAME = "CRAS-Desktop.exe"
MAX_UPDATE_BYTES = 250 * 1024 * 1024
PORT = 8765
MOBILE_PORT = 8766
LOCAL_IPV4_NETWORKS = tuple(
    ipaddress.IPv4Network(network)
    for network in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")
)
MAX_BODY_BYTES = 12 * 1024 * 1024
MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024
MAX_SERVER_TRANSFER_BYTES = 256 * 1024 * 1024
AUTO_BACKUP_RETENTION = 30
MAX_CHAT_TEXT_LENGTH = 4000
MAX_CHAT_ATTACHMENT_BYTES = 2 * 1024 * 1024
MAX_CHAT_MESSAGE_BYTES = 3 * 1024 * 1024
CHAT_ATTACHMENT_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}
CENTRAL_SERVICE_TYPE = "_cras-central._tcp.local."
MACHINE_EXPORT_FORMAT = "cras-ouro-preto-machine-export"
MACHINE_EXPORT_VERSION = 1
TECHNICAL_E2EE_SETTING = "cras-ouro-preto-technical-e2ee-v1"

PBKDF2_ITERATIONS = 200_000
MOBILE_ACCESS_ITERATIONS = 600_000

EMPTY_SNAPSHOT = {"appointments": [], "people": [], "paaRecords": [], "settings": {}}
VALID_USER_ROLES = {"assistant", "caseworker", "reception", "intern", "admin"}
MOBILE_ACCESS_MIN_LENGTH = 12
MOBILE_ACCESS_MAX_ATTEMPTS = 5
MOBILE_ACCESS_WINDOW_SECONDS = 300
USER_AUTH_MAX_ATTEMPTS = 5
USER_AUTH_WINDOW_SECONDS = 300
MISSING = object()


def update_ssl_context() -> ssl.SSLContext:
    return truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)


class RevisionConflict(Exception):
    def __init__(self, revision: int):
        super().__init__("O estado compartilhado mudou durante a gravação.")
        self.revision = revision


def resource_path(name: str) -> Path:
    root = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
    return root / name


def central_hostname(node_id: str) -> str:
    return f"cras-{node_id[:12]}.local"


def data_path() -> Path:
    base = os.environ.get("LOCALAPPDATA")
    root = Path(base) if base else Path.home() / "AppData" / "Local"
    path = root / APP_NAME
    path.mkdir(parents=True, exist_ok=True)
    return path


def app_version() -> str:
    return resource_path("version.txt").read_text(encoding="utf-8").strip()


def version_tuple(version: str) -> tuple[int, int, int]:
    match = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)", version)
    if not match:
        raise ValueError(f"Versão inválida: {version}")
    return int(match.group(1)), int(match.group(2)), int(match.group(3))


def require_compatible_sync_version(client_version: object) -> None:
    current_version = app_version()
    try:
        compatible = (
            isinstance(client_version, str)
            and version_tuple(client_version) == version_tuple(current_version)
        )
    except ValueError:
        compatible = False
    if not compatible:
        reported_version = client_version if isinstance(client_version, str) else "desconhecida"
        raise ValueError(
            f"Versões incompatíveis para sincronização ({reported_version} e {current_version}). "
            f"Atualize todos os dispositivos para a versão {current_version}."
        )


def latest_release() -> dict | None:
    request = Request(
        GITHUB_RELEASES_API,
        headers={"Accept": "application/vnd.github+json", "User-Agent": APP_NAME},
    )
    try:
        with urlopen(request, timeout=20, context=update_ssl_context()) as response:
            release = json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        if error.code == 404:
            return None
        raise
    if not isinstance(release, dict) or release.get("draft") or release.get("prerelease"):
        return None

    tag_name = release.get("tag_name")
    if not isinstance(tag_name, str):
        raise ValueError("A versão da publicação no GitHub está inválida.")
    if version_tuple(tag_name) <= version_tuple(app_version()):
        return None

    assets = release.get("assets")
    if not isinstance(assets, list):
        raise ValueError("A publicação no GitHub não contém arquivos válidos.")
    by_name = {
        asset["name"]: asset
        for asset in assets
        if isinstance(asset, dict) and isinstance(asset.get("name"), str)
    }
    executable = by_name.get(UPDATE_ASSET_NAME)
    checksum = by_name.get(f"{UPDATE_ASSET_NAME}.sha256")
    if not executable or not checksum:
        raise ValueError("A publicação não contém o executável e seu checksum.")
    for asset in (executable, checksum):
        url = asset.get("browser_download_url")
        parsed_url = urlsplit(url) if isinstance(url, str) else None
        if (
            parsed_url is None
            or parsed_url.scheme != "https"
            or parsed_url.netloc != "github.com"
            or not parsed_url.path.startswith(f"/{GITHUB_REPOSITORY}/releases/download/")
            or parsed_url.query
            or parsed_url.fragment
        ):
            raise ValueError("A publicação contém um link de download inválido.")
    return {
        "version": tag_name,
        "executable_url": executable["browser_download_url"],
        "checksum_url": checksum["browser_download_url"],
    }


def download_update(release: dict, directory: Path) -> Path:
    def download(url: str) -> bytes:
        request = Request(url, headers={"User-Agent": APP_NAME})
        buffer = bytearray()
        with urlopen(request, timeout=120, context=update_ssl_context()) as response:
            while True:
                chunk = response.read(65536)
                if not chunk:
                    break
                buffer.extend(chunk)
                if len(buffer) > MAX_UPDATE_BYTES:
                    raise ValueError("O arquivo de atualização excede o limite permitido.")
        return bytes(buffer)

    executable = download(release["executable_url"])
    checksum_text = download(release["checksum_url"]).decode("ascii", errors="replace").strip()
    verify_update_checksum(executable, checksum_text)

    update_path = directory / "CRAS-Desktop-update.exe"
    update_path.write_bytes(executable)
    return update_path


def verify_update_checksum(executable: bytes, checksum_text: str) -> None:
    match = re.fullmatch(r"([0-9a-fA-F]{64})(?:\s+\*?CRAS-Desktop\.exe)?", checksum_text)
    if not match or hashlib.sha256(executable).hexdigest().lower() != match.group(1).lower():
        raise ValueError("O checksum do arquivo de atualização não confere.")


def powershell_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def launch_update_helper(update_path: Path, executable_path: Path, process_id: int, directory: Path) -> None:
    script_path = directory / "apply-update.ps1"
    log_path = directory / "update.log"
    script = f"""$ErrorActionPreference = 'Stop'
$appProcessId = {process_id}
$source = {powershell_literal(str(update_path))}
$target = {powershell_literal(str(executable_path))}
$staged = "$target.update"
$backup = "$target.previous"
$logPath = {powershell_literal(str(log_path))}
function Write-UpdateLog($message) {{
    Add-Content -LiteralPath $logPath -Encoding UTF8 -Value "$(Get-Date -Format o) $message"
}}
try {{
    Write-UpdateLog "Aguardando o CRAS Desktop encerrar (PID $appProcessId)."
    if (Get-Process -Id $appProcessId -ErrorAction SilentlyContinue) {{
        Wait-Process -Id $appProcessId -Timeout 120
    }}
    if (Get-Process -Id $appProcessId -ErrorAction SilentlyContinue) {{
        throw "O CRAS Desktop não encerrou dentro do prazo."
    }}
    Start-Sleep -Seconds 1
    if (Test-Path -LiteralPath $backup) {{
        Remove-Item -LiteralPath $backup -Force
    }}
    if (Test-Path -LiteralPath $staged) {{
        Remove-Item -LiteralPath $staged -Force
    }}
    Write-UpdateLog "Preparando o executável atualizado."
    Copy-Item -LiteralPath $source -Destination $staged -Force
    $replaced = $false
    if (Test-Path -LiteralPath $target) {{
        $lastError = $null
        for ($i = 1; $i -le 10; $i++) {{
            try {{
                [System.IO.File]::Replace($staged, $target, $backup)
                $replaced = $true
                break
            }} catch {{
                $lastError = $_.Exception.Message
                Write-UpdateLog "Tentativa $i de substituir o executável falhou ($lastError). Aguardando liberação do arquivo..."
                Start-Sleep -Milliseconds 500
            }}
        }}
        if (-not $replaced) {{
            throw "Não foi possível substituir o executável após múltiplas tentativas: $lastError"
        }}
    }} else {{
        Move-Item -LiteralPath $staged -Destination $target
        $replaced = $true
    }}
    if (-not $replaced) {{
        throw "Não foi possível instalar o executável atualizado."
    }}
    Write-UpdateLog "Executável substituído. Abrindo a nova versão."
    Start-Process -FilePath $target
    Write-UpdateLog "Atualização concluída."
    try {{
        Remove-Item -LiteralPath $backup, $source -Force
    }} catch {{
        Write-UpdateLog "Aviso: não foi possível limpar os arquivos temporários: $($_.Exception.Message)"
    }}
}} catch {{
    $failure = $_.Exception.Message
    Write-UpdateLog "Falha na atualização: $failure"
    if (Test-Path -LiteralPath $backup) {{
        if (Test-Path -LiteralPath $target) {{
            Remove-Item -LiteralPath $target -Force
        }}
        Move-Item -LiteralPath $backup -Destination $target -Force
        Write-UpdateLog "A versão anterior foi restaurada."
    }}
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
        "A atualização não foi concluída. O CRAS Desktop anterior foi mantido, quando possível.`n`n$failure`n`nRegistro: $logPath",
        "CRAS Desktop",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
}}
"""
    script_path.write_text(script, encoding="utf-8-sig")
    subprocess.Popen(
        [
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(script_path),
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )


def check_for_update() -> bool:
    if not getattr(sys, "frozen", False) or os.name != "nt":
        return False
    try:
        release = latest_release()
    except (HTTPError, URLError, OSError, ValueError, UnicodeError) as error:
        logging.warning("Não foi possível verificar atualizações no GitHub: %s", error)
        return False
    if release is None:
        return False
    import tkinter
    from tkinter import messagebox
    root = tkinter.Tk()
    root.withdraw()
    accepted = messagebox.askyesno(
        APP_NAME,
        f"A versão {release['version']} está disponível. Deseja baixar e instalar agora?",
        parent=root,
    )
    root.destroy()
    if not accepted:
        return False
    try:
        directory = data_path()
        update_path = download_update(release, directory)
        launch_update_helper(update_path, Path(sys.executable), os.getpid(), directory)
        return True
    except (HTTPError, URLError, OSError, ValueError, UnicodeError) as error:
        logging.exception("Não foi possível instalar a atualização.")
        root = tkinter.Tk()
        root.withdraw()
        messagebox.showerror(
            APP_NAME,
            f"Não foi possível instalar a atualização. O aplicativo atual será mantido.\n\nDetalhe: {error}",
            parent=root,
        )
        root.destroy()
        return False
def canonical(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def validate_annotations(annotations: object) -> None:
    if not isinstance(annotations, dict):
        raise ValueError("As anotações do atendimento estão inválidas.")
    if set(annotations) - {"assistencia", "cadastro"}:
        raise ValueError("O atendimento contém uma categoria de anotação desconhecida.")
    for category in ("assistencia", "cadastro"):
        entries = annotations.get(category, [])
        if not isinstance(entries, list):
            raise ValueError("A lista de anotações do atendimento está inválida.")
        seen_ids: set[str] = set()
        for entry in entries:
            if not isinstance(entry, dict):
                raise ValueError("Há uma anotação inválida no atendimento.")
            entry_id = entry.get("id")
            text = entry.get("text")
            author_name = entry.get("authorName")
            author_role = entry.get("authorRole")
            expected_role = "assistant" if category == "assistencia" else "caseworker"
            if (
                not isinstance(entry_id, str)
                or not entry_id.strip()
                or entry_id in seen_ids
                or not isinstance(text, str)
                or not text.strip()
                or len(text) > 6000
                or not isinstance(author_name, str)
                or not author_name.strip()
                or len(author_name) > 60
                or not isinstance(author_role, str)
                or author_role not in {expected_role, "admin"}
            ):
                raise ValueError("Há uma anotação incompleta ou incompatível com sua categoria.")
            seen_ids.add(entry_id)
            for field in ("attendanceDate", "createdAt", "updatedAt"):
                value = entry.get(field)
                if value is None and field == "updatedAt":
                    continue
                if not isinstance(value, str):
                    raise ValueError("A data de uma anotação está inválida.")
                try:
                    datetime.fromisoformat(value.replace("Z", "+00:00"))
                except ValueError as error:
                    raise ValueError("A data de uma anotação está inválida.") from error
            if "updatedBy" in entry and (
                not isinstance(entry["updatedBy"], str) or len(entry["updatedBy"]) > 60
            ):
                raise ValueError("O autor da última edição está inválido.")


def validate_technical_ciphertext(value: object) -> None:
    if not isinstance(value, dict) or value.get("version") != 1:
        raise ValueError("O pacote de anotações técnicas criptografadas está inválido.")
    try:
        nonce = base64.b64decode(value.get("nonce", ""), validate=True)
        ciphertext = base64.b64decode(value.get("ciphertext", ""), validate=True)
    except (ValueError, TypeError) as error:
        raise ValueError("O pacote de anotações técnicas criptografadas está inválido.") from error
    if len(nonce) != 12 or len(ciphertext) < 16 or len(ciphertext) > 40_000:
        raise ValueError("O pacote de anotações técnicas criptografadas está inválido.")


def technical_e2ee_enabled(snapshot: dict) -> bool:
    config = snapshot.get("settings", {}).get(TECHNICAL_E2EE_SETTING)
    if config is None:
        return False
    if not isinstance(config, dict) or config.get("version") != 1:
        raise ValueError("A configuração de criptografia técnica está inválida.")
    validate_technical_ciphertext(config.get("keyCheck"))
    return True


def validate_technical_e2ee_snapshot(snapshot: dict) -> bool:
    enabled = technical_e2ee_enabled(snapshot)
    if not enabled:
        return False
    for record in snapshot["appointments"]:
        annotations = record.get("annotations", {})
        if annotations.get("assistencia", []):
            raise ValueError(
                "A sincronização foi bloqueada: há anotações técnicas sem criptografia ponta a ponta."
            )
        if "technicalAnnotationsCiphertext" in record:
            validate_technical_ciphertext(record["technicalAnnotationsCiphertext"])
    return True


def validate_snapshot(snapshot: object) -> dict:
    if not isinstance(snapshot, dict):
        raise ValueError("O pacote de sincronização está inválido.")
    if not isinstance(snapshot.get("appointments"), list) or not isinstance(snapshot.get("paaRecords"), list):
        raise ValueError("As coleções de atendimentos ou PAA estão inválidas.")
    if "people" not in snapshot:
        snapshot["people"] = []
    if not isinstance(snapshot.get("people"), list):
        raise ValueError("A coleção de pessoas está inválida.")
    if not isinstance(snapshot.get("settings"), dict):
        raise ValueError("As configurações sincronizadas estão inválidas.")
    if len(canonical(snapshot).encode("utf-8")) > MAX_SNAPSHOT_BYTES:
        raise ValueError("Os dados para sincronização excederam o limite permitido.")
    for collection in ("appointments", "paaRecords"):
        seen: set[str] = set()
        for item in snapshot[collection]:
            if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"].strip():
                raise ValueError(f"Há um registro inválido na coleção {collection}.")
            if item["id"] in seen:
                raise ValueError(f"Há um identificador duplicado na coleção {collection}.")
            if len(canonical(item).encode("utf-8")) > 45_000:
                raise ValueError(f"Um registro da coleção {collection} excedeu o limite permitido.")
            if collection == "appointments" and "annotations" in item:
                validate_annotations(item["annotations"])
            if collection == "appointments" and "technicalAnnotationsCiphertext" in item:
                validate_technical_ciphertext(item["technicalAnnotationsCiphertext"])
            seen.add(item["id"])
    seen_people: set[str] = set()
    for person in snapshot["people"]:
        if not isinstance(person, dict) or not isinstance(person.get("key"), str) or not person["key"].strip():
            raise ValueError("Há um cadastro de pessoa inválido.")
        if person["key"] in seen_people:
            raise ValueError("Há identificadores de pessoa duplicados.")
        if person.get("id") is not None and (
            isinstance(person.get("id"), bool)
            or not isinstance(person.get("id"), int)
            or person["id"] < 1
        ):
            raise ValueError("Há um número de pessoa inválido.")
        if len(canonical(person).encode("utf-8")) > 45_000:
            raise ValueError("Um cadastro de pessoa excedeu o limite permitido.")
        seen_people.add(person["key"])
    validate_technical_e2ee_snapshot(snapshot)
    return snapshot


def machine_export_value(value: object) -> object:
    if isinstance(value, dict):
        return {
            key: machine_export_value(item)
            for key, item in value.items()
            if key not in {"_syncMeta", "personKey"}
        }
    if isinstance(value, list):
        return [machine_export_value(item) for item in value]
    return value


def is_valid_local_ipv4(address: ipaddress.IPv4Address) -> bool:
    return any(address in network for network in LOCAL_IPV4_NETWORKS)


def validate_chat_message(message: object) -> dict:
    if not isinstance(message, dict):
        raise ValueError("A mensagem do chat está inválida.")
    message_id = message.get("id")
    created_at = message.get("createdAt")
    author_id = message.get("authorId")
    author_name = message.get("authorName")
    author_role = message.get("authorRole")
    recipient_id = message.get("recipientId")
    text = message.get("text", "")
    if (
        not isinstance(message_id, str)
        or not message_id.strip()
        or len(message_id) > 100
        or not isinstance(created_at, str)
        or len(created_at) > 50
        or not isinstance(author_id, str)
        or not author_id.strip()
        or len(author_id) > 100
        or not isinstance(author_name, str)
        or not author_name.strip()
        or len(author_name) > 100
        or not isinstance(author_role, str)
        or author_role not in VALID_USER_ROLES
        or recipient_id is not None
        and (
            not isinstance(recipient_id, str)
            or not recipient_id.strip()
            or len(recipient_id) > 100
            or recipient_id == author_id
        )
        or not isinstance(text, str)
        or len(text) > MAX_CHAT_TEXT_LENGTH
    ):
        raise ValueError("Os dados básicos da mensagem do chat são inválidos.")
    try:
        message_date = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError("A data da mensagem do chat é inválida.") from error
    if message_date.tzinfo is None:
        raise ValueError("A data da mensagem do chat precisa incluir o fuso horário.")
    validated = {
        "id": message_id,
        "createdAt": message_date.astimezone(timezone.utc).isoformat(),
        "authorId": author_id,
        "authorName": author_name.strip(),
        "authorRole": author_role,
        "text": text,
    }
    if recipient_id is not None:
        validated["recipientId"] = recipient_id.strip()

    person = message.get("person")
    if person is not None:
        if (
            not isinstance(person, dict)
            or not isinstance(person.get("id"), str)
            or not person["id"].strip()
            or len(person["id"]) > 100
            or not isinstance(person.get("name"), str)
            or not person["name"].strip()
            or len(person["name"]) > 120
            or not isinstance(person.get("cpfMasked", ""), str)
            or len(person.get("cpfMasked", "")) > 24
        ):
            raise ValueError("A pessoa vinculada à mensagem está inválida.")
        validated["person"] = {
            "id": person["id"],
            "name": person["name"].strip(),
            "cpfMasked": person.get("cpfMasked", ""),
        }

    attachment = message.get("attachment")
    if attachment is not None:
        if (
            not isinstance(attachment, dict)
            or not isinstance(attachment.get("name"), str)
            or not attachment["name"].strip()
            or len(attachment["name"]) > 120
            or "/" in attachment["name"]
            or "\\" in attachment["name"]
            or not isinstance(attachment.get("type"), str)
            or attachment["type"] not in CHAT_ATTACHMENT_TYPES
            or not isinstance(attachment.get("data"), str)
        ):
            raise ValueError("O anexo do chat é inválido.")
        try:
            attachment_bytes = base64.b64decode(attachment["data"], validate=True)
        except (ValueError, binascii.Error) as error:
            raise ValueError("Os dados do anexo não estão em base64 válido.") from error
        if not attachment_bytes or len(attachment_bytes) > MAX_CHAT_ATTACHMENT_BYTES:
            raise ValueError("O anexo deve ter no máximo 2 MB.")
        signatures = {
            "image/png": attachment_bytes.startswith(b"\x89PNG\r\n\x1a\n"),
            "image/jpeg": attachment_bytes.startswith(b"\xff\xd8\xff"),
            "image/gif": attachment_bytes.startswith((b"GIF87a", b"GIF89a")),
            "image/webp": (
                len(attachment_bytes) >= 12
                and attachment_bytes[:4] == b"RIFF"
                and attachment_bytes[8:12] == b"WEBP"
            ),
        }
        if not signatures[attachment["type"]]:
            raise ValueError("O conteúdo do anexo não corresponde ao formato de imagem informado.")
        validated["attachment"] = {
            "name": attachment["name"].strip(),
            "type": attachment["type"],
            "data": attachment["data"],
        }

    if not text.strip() and "person" not in validated and "attachment" not in validated:
        raise ValueError("Escreva uma mensagem ou inclua uma pessoa ou imagem.")
    if len(canonical(validated).encode("utf-8")) > MAX_CHAT_MESSAGE_BYTES:
        raise ValueError("A mensagem do chat excedeu o limite permitido.")
    return validated
def derive_key(password: str, salt: bytes) -> bytes:
    return PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=PBKDF2_ITERATIONS,
    ).derive(password.encode("utf-8"))


def validate_user_credential(user_id: object, credential: object) -> tuple[str, str, str]:
    if (
        not isinstance(user_id, str)
        or not user_id.strip()
        or len(user_id) > 100
        or not isinstance(credential, dict)
        or not isinstance(credential.get("salt"), str)
        or not isinstance(credential.get("hash"), str)
        or not re.fullmatch(r"[a-f0-9]{64}", credential["hash"], re.IGNORECASE)
    ):
        raise ValueError("A credencial individual do usuário está inválida.")
    try:
        salt = base64.b64decode(credential["salt"], validate=True)
    except (ValueError, binascii.Error) as error:
        raise ValueError("O sal da credencial individual está inválido.") from error
    if len(salt) != 16:
        raise ValueError("O sal da credencial individual está inválido.")
    return user_id.strip(), credential["salt"], credential["hash"].lower()


def user_authentication_proof(
    password_hash: str,
    user_id: str,
    challenge_id: str,
    nonce: str,
) -> str:
    message = "\n".join((
        "CRAS-Desktop user authentication v1",
        user_id,
        challenge_id,
        nonce,
    )).encode("utf-8")
    return hmac.new(bytes.fromhex(password_hash), message, hashlib.sha256).hexdigest()


class _CentralServiceListener(ServiceListener):
    def __init__(self):
        self.services: dict[str, dict] = {}
        self.lock = threading.Lock()

    def add_service(self, zeroconf, service_type, name):
        info = zeroconf.get_service_info(service_type, name)
        if not info:
            return
        try:
            node_id = info.properties.get(b"nodeId", b"").decode("utf-8")
            addresses = []
            for value in info.parsed_scoped_addresses(IPVersion.V4Only):
                address = ipaddress.IPv4Address(value)
                if is_valid_local_ipv4(address):
                    addresses.append(str(address))
        except (UnicodeError, ValueError):
            return
        if not node_id or not addresses or info.port != PORT:
            return
        with self.lock:
            self.services[name] = {
                "nodeId": node_id,
                "addresses": sorted(set(addresses)),
                "port": info.port,
            }

    def remove_service(self, zeroconf, service_type, name):
        with self.lock:
            self.services.pop(name, None)

    def update_service(self, zeroconf, service_type, name):
        self.add_service(zeroconf, service_type, name)


class CentralServiceAdvertiser:
    def __init__(self, node_id: str):
        self.node_id = node_id
        self.zeroconf = None
        self.info = None
        self.lock = threading.RLock()

    def set_enabled(self, enabled: bool) -> None:
        if not isinstance(enabled, bool):
            raise ValueError("A configuração do servidor central é inválida.")
        if enabled and not HAVE_ZEROCONF:
            raise RuntimeError("A descoberta automática não está instalada. Atualize o CRAS Desktop.")
        with self.lock:
            if enabled and self.info:
                return
            if not enabled and not self.info:
                return
            if enabled:
                addresses = lan_addresses()
                if not addresses:
                    raise RuntimeError("Este computador não possui um endereço de rede local ativo.")
                zeroconf = Zeroconf(ip_version=IPVersion.V4Only)
                hostname = f"{central_hostname(self.node_id)}."
                info = ServiceInfo(
                    CENTRAL_SERVICE_TYPE,
                    f"CRAS-{self.node_id[:8]}.{CENTRAL_SERVICE_TYPE}",
                    addresses=[ipaddress.IPv4Address(address).packed for address in addresses],
                    port=PORT,
                    properties={"nodeId": self.node_id},
                    server=hostname,
                )
                try:
                    zeroconf.register_service(info)
                except Exception:
                    zeroconf.close()
                    raise
                self.zeroconf = zeroconf
                self.info = info
                return
            zeroconf, info = self.zeroconf, self.info
            self.zeroconf = None
            self.info = None
            zeroconf.unregister_service(info)
            zeroconf.close()

    def close(self) -> None:
        self.set_enabled(False)


def _probe_central_endpoint(address: str) -> dict | None:
    url = f"http://{address}:{PORT}/api/info"
    try:
        request = Request(url, headers={"Accept": "application/json", "Cache-Control": "no-store"})
        with urlopen(request, timeout=0.20) as response:
            if response.status != 200:
                return None
            info = json.loads(response.read(MAX_BODY_BYTES).decode("utf-8"))
    except (HTTPError, URLError, OSError, json.JSONDecodeError, UnicodeDecodeError):
        return None
    node_id = info.get("nodeId") if isinstance(info, dict) else None
    if not isinstance(node_id, str) or not node_id or info.get("centralServer") is not True:
        return None
    return {"nodeId": node_id, "endpoints": [f"http://{address}:{PORT}"]}


def _scan_central_services() -> list[dict]:
    candidates: list[str] = []
    seen_candidates: set[str] = set()
    for address_text in lan_addresses():
        try:
            address = ipaddress.IPv4Address(address_text)
        except ipaddress.AddressValueError:
            continue
        network = ipaddress.IPv4Network(f"{address}/24", strict=False)
        for candidate in network.hosts():
            candidate_text = str(candidate)
            if candidate != address and candidate_text not in seen_candidates:
                candidates.append(candidate_text)
                seen_candidates.add(candidate_text)
    if not candidates:
        return []

    found: dict[str, dict] = {}
    executor = ThreadPoolExecutor(max_workers=32, thread_name_prefix="cras-discovery")
    futures = {
        executor.submit(_probe_central_endpoint, candidate): candidate
        for candidate in candidates
    }
    pending = set(futures)
    try:
        completed, pending = wait(futures, timeout=6.0)
        for future in completed:
            try:
                result = future.result()
            except Exception:
                continue
            if result:
                found[result["nodeId"]] = result
    finally:
        for future in pending:
            future.cancel()
        executor.shutdown(wait=False, cancel_futures=True)
    return list(found.values())


def discover_central_services(timeout: float = 3.0) -> list[dict]:
    if not HAVE_ZEROCONF:
        raise RuntimeError("A descoberta automática não está instalada. Atualize o CRAS Desktop.")
    zeroconf = Zeroconf(ip_version=IPVersion.V4Only)
    listener = _CentralServiceListener()
    browser = ServiceBrowser(zeroconf, CENTRAL_SERVICE_TYPE, listener)
    try:
        time.sleep(timeout)
        with listener.lock:
            services = list(listener.services.values())
        discovered = [
            {
                "nodeId": service["nodeId"],
                "endpoints": [
                    f"http://{address}:{service['port']}" for address in service["addresses"]
                ],
            }
            for service in services
        ]
        if discovered:
            return discovered
        return _scan_central_services()
    finally:
        browser.cancel()
        zeroconf.close()
def derive_mobile_access_key(password: str, salt: bytes) -> bytes:
    return PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=MOBILE_ACCESS_ITERATIONS,
    ).derive(password.encode("utf-8"))
def encode_mobile_payload(key: bytes, payload: dict) -> dict:
    nonce = secrets.token_bytes(12)
    ciphertext = AESGCM(key).encrypt(nonce, canonical(payload).encode("utf-8"), None)
    return {
        "nonce": base64.b64encode(nonce).decode("ascii"),
        "ciphertext": base64.b64encode(ciphertext).decode("ascii"),
    }
def decode_mobile_payload(envelope: object, key: bytes) -> dict:
    if not isinstance(envelope, dict):
        raise ValueError("Pacote móvel inválido.")
    nonce = base64.b64decode(envelope.get("nonce", ""), validate=True)
    ciphertext = base64.b64decode(envelope.get("ciphertext", ""), validate=True)
    if len(nonce) != 12 or not ciphertext or len(ciphertext) > MAX_BODY_BYTES:
        raise ValueError("Pacote móvel inválido.")
    payload = json.loads(AESGCM(key).decrypt(nonce, ciphertext, None).decode("utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Conteúdo móvel inválido.")
    return payload
def decode_envelope(envelope: object, password: str) -> tuple[bytes, dict]:
    if not isinstance(envelope, dict):
        raise ValueError("Pacote criptografado inválido.")
    salt = base64.b64decode(envelope.get("salt", ""), validate=True)
    nonce = base64.b64decode(envelope.get("nonce", ""), validate=True)
    ciphertext = base64.b64decode(envelope.get("ciphertext", ""), validate=True)
    if len(salt) != 16 or len(nonce) != 12 or not ciphertext or len(ciphertext) > MAX_BODY_BYTES:
        raise ValueError("Pacote criptografado inválido.")
    cleartext = AESGCM(derive_key(password, salt)).decrypt(nonce, ciphertext, None)
    payload = json.loads(cleartext.decode("utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Conteúdo de sincronização inválido.")
    return salt, payload
def encode_envelope(salt: bytes, password: str, payload: dict) -> dict:
    nonce = secrets.token_bytes(12)
    ciphertext = AESGCM(derive_key(password, salt)).encrypt(
        nonce, canonical(payload).encode("utf-8"), None
    )
    return {
        "salt": base64.b64encode(salt).decode("ascii"),
        "nonce": base64.b64encode(nonce).decode("ascii"),
        "ciphertext": base64.b64encode(ciphertext).decode("ascii"),
    }
class PeerStore:
    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.RLock()
        self.ready = False
        self.machine_export_revision = 0
        self.machine_exported_at = ""
        self.machine_export_error = ""
        self.user_auth_challenges: dict[str, tuple[str, str, float]] = {}
        self.user_auth_failures: dict[str, list[float]] = {}
        with closing(self.connect()) as db:
            with db:
                db.execute("CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
                db.execute("CREATE TABLE IF NOT EXISTS peer_bases (peer_id TEXT PRIMARY KEY, payload TEXT NOT NULL)")
                db.execute(
                    "CREATE TABLE IF NOT EXISTS seen_requests "
                    "(peer_id TEXT NOT NULL, request_id TEXT NOT NULL, PRIMARY KEY(peer_id, request_id))"
                )
                db.execute(
                    "CREATE TABLE IF NOT EXISTS current_snapshot "
                    "(id INTEGER PRIMARY KEY CHECK(id = 1), payload TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0)"
                )
                db.execute(
                    "CREATE TABLE IF NOT EXISTS chat_messages "
                    "(id TEXT PRIMARY KEY, created_at TEXT NOT NULL, month TEXT NOT NULL, payload TEXT NOT NULL, "
                    "author_id TEXT, recipient_id TEXT)"
                )
                chat_columns = {
                    row[1] for row in db.execute("PRAGMA table_info(chat_messages)").fetchall()
                }
                if "author_id" not in chat_columns:
                    db.execute("ALTER TABLE chat_messages ADD COLUMN author_id TEXT")
                if "recipient_id" not in chat_columns:
                    db.execute("ALTER TABLE chat_messages ADD COLUMN recipient_id TEXT")
                db.execute(
                    "CREATE TABLE IF NOT EXISTS user_credentials "
                    "(user_id TEXT PRIMARY KEY, salt TEXT NOT NULL, password_hash TEXT NOT NULL, "
                    "display_name TEXT, role TEXT)"
                )
                credential_columns = {
                    row[1] for row in db.execute("PRAGMA table_info(user_credentials)").fetchall()
                }
                if "display_name" not in credential_columns:
                    db.execute("ALTER TABLE user_credentials ADD COLUMN display_name TEXT")
                if "role" not in credential_columns:
                    db.execute("ALTER TABLE user_credentials ADD COLUMN role TEXT")
                db.execute(
                    "INSERT OR IGNORE INTO current_snapshot (id, payload) VALUES (1, ?)",
                    (canonical(EMPTY_SNAPSHOT),),
                )
                self.node_id = self.get_or_create(db, "node_id", str(uuid.uuid4()))
                self.active_role = self.get_or_create(db, "active_role", "")
                self.get_or_create(db, "is_principal", "false")
                self.get_or_create(db, "is_central_server", "false")
                self.get_or_create(db, "next_person_id", "1")
                db.execute(
                    "DELETE FROM metadata WHERE key IN "
                    "('pairing_key', 'peer_directory', 'manual_addresses')"
                )
# OTIMIZAÇÃO 2: Configuração do SQLite para não travar a escrita em disco
    def connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=15)
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA synchronous=NORMAL")
        return db
    @staticmethod
    def get_or_create(db: sqlite3.Connection, key: str, value: str) -> str:
        row = db.execute("SELECT value FROM metadata WHERE key = ?", (key,)).fetchone()
        if row:
            return str(row[0])
        db.execute("INSERT INTO metadata (key, value) VALUES (?, ?)", (key, value))
        return value

    @staticmethod
    def person_signature(cpf: object, name: object) -> tuple[str, str] | None:
        normalized_cpf = re.sub(r"\D", "", cpf) if isinstance(cpf, str) else ""
        normalized_name = " ".join(name.split()).casefold() if isinstance(name, str) else ""
        return (normalized_cpf, normalized_name) if len(normalized_cpf) == 11 and normalized_name else None

    @staticmethod
    def preserve_person_fields(snapshot: dict, previous: dict) -> None:
        previous_by_id = {
            record["id"]: record
            for record in previous.get("appointments", [])
            if isinstance(record, dict) and isinstance(record.get("id"), str)
        }
        for record in snapshot.get("appointments", []):
            previous_record = previous_by_id.get(record.get("id"))
            if not previous_record:
                continue
            for field in ("personKey", "personId", "annotations"):
                if field not in record and field in previous_record:
                    record[field] = previous_record[field]

    def ensure_people_snapshot(
        self, db: sqlite3.Connection, snapshot: dict, assign_numbers: bool
    ) -> None:
        people_by_key: dict[str, dict] = {}
        signature_keys: dict[tuple[str, str], str] = {}
        aliases: dict[str, str] = {}
        sorted_people = sorted(
            snapshot.get("people", []),
            key=lambda person: (
                person.get("id") if isinstance(person.get("id"), int) else 2**63,
                person["key"],
            ),
        )
        for source in sorted_people:
            person = dict(source)
            person_key = person["key"]
            signature = self.person_signature(person.get("cpf"), person.get("name"))
            canonical_key = signature_keys.get(signature) if signature else None
            if canonical_key:
                aliases[person_key] = canonical_key
                continue
            person["cpf"] = re.sub(r"\D", "", person.get("cpf", "")) if isinstance(person.get("cpf"), str) else ""
            people_by_key[person_key] = person
            if signature:
                signature_keys[signature] = person_key

        people_by_id = {
            person["id"]: person["key"]
            for person in people_by_key.values()
            if isinstance(person.get("id"), int) and not isinstance(person.get("id"), bool)
        }
        appointments = sorted(
            snapshot["appointments"],
            key=lambda record: (str(record.get("createdAt", "")), record["id"]),
        )
        for record in appointments:
            person_key = aliases.get(record.get("personKey"), record.get("personKey"))
            if not isinstance(person_key, str) or person_key not in people_by_key:
                person_key = people_by_id.get(record.get("personId"))
            signature = self.person_signature(record.get("cpf"), record.get("nome"))
            if not isinstance(person_key, str) or person_key not in people_by_key:
                person_key = signature_keys.get(signature) if signature else None
            if not isinstance(person_key, str) or person_key not in people_by_key:
                person_key = str(uuid.uuid4())
                person = {
                    "key": person_key,
                    "id": None,
                    "name": record.get("nome", ""),
                    "cpf": re.sub(r"\D", "", record.get("cpf", "")) if isinstance(record.get("cpf"), str) else "",
                    "createdAt": str(record.get("createdAt", "")),
                }
                people_by_key[person_key] = person
                if signature:
                    signature_keys[signature] = person_key
            person = people_by_key[person_key]
            person.setdefault("name", record.get("nome", ""))
            person.setdefault(
                "cpf",
                re.sub(r"\D", "", record.get("cpf", "")) if isinstance(record.get("cpf"), str) else "",
            )
            person.setdefault("createdAt", str(record.get("createdAt", "")))
            record["personKey"] = person_key
            record["personId"] = person.get("id")

        used_numbers: set[int] = set()
        for person in sorted(
            people_by_key.values(),
            key=lambda item: (
                item.get("id") if isinstance(item.get("id"), int) else 2**63,
                item["key"],
            ),
        ):
            person_id = person.get("id")
            if not isinstance(person_id, int) or isinstance(person_id, bool) or person_id < 1 or person_id in used_numbers:
                person["id"] = None
            else:
                used_numbers.add(person_id)

        if assign_numbers:
            row = db.execute(
                "SELECT value FROM metadata WHERE key = 'next_person_id'"
            ).fetchone()
            try:
                next_person_id = max(int(row[0]) if row else 1, max(used_numbers, default=0) + 1)
            except (TypeError, ValueError):
                next_person_id = max(used_numbers, default=0) + 1
            unnumbered_people = sorted(
                (person for person in people_by_key.values() if person["id"] is None),
                key=lambda item: (str(item.get("createdAt", "")), item["key"]),
            )
            for person in unnumbered_people:
                person["id"] = next_person_id
                used_numbers.add(next_person_id)
                next_person_id += 1
            db.execute(
                "INSERT INTO metadata (key, value) VALUES ('next_person_id', ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (str(next_person_id),),
            )

        for record in snapshot["appointments"]:
            person = people_by_key.get(record.get("personKey"))
            if person:
                record["personId"] = person.get("id")
        snapshot["people"] = sorted(
            people_by_key.values(),
            key=lambda item: (item.get("id") is None, item.get("id") or 0, item["key"]),
        )

    def set_central_server(self, enabled: bool) -> None:
        if not isinstance(enabled, bool):
            raise ValueError("A configuração do servidor central é inválida.")
        with self.lock, closing(self.connect()) as db:
            with db:
                db.execute(
                    "UPDATE metadata SET value = ? WHERE key = 'is_central_server'",
                    ("true" if enabled else "false",),
                )
                row = db.execute("SELECT payload FROM current_snapshot WHERE id = 1").fetchone()
                snapshot = validate_snapshot(json.loads(row[0])) if row else dict(EMPTY_SNAPSHOT)
                previous = canonical(snapshot)
                self.ensure_people_snapshot(db, snapshot, enabled)
                if canonical(snapshot) != previous:
                    db.execute(
                        "UPDATE current_snapshot SET payload = ?, revision = revision + 1 WHERE id = 1",
                        (canonical(snapshot),),
                    )
        if enabled:
            self.refresh_machine_export()
    def is_central_server(self) -> bool:
        with self.lock, closing(self.connect()) as db:
            row = db.execute(
                "SELECT value FROM metadata WHERE key = 'is_central_server'"
            ).fetchone()
            return bool(row and row[0] == "true")
    @property
    def machine_export_path(self) -> Path:
        return self.path.parent / "exports" / "cras-machine-data-v1.json"
    def machine_export_status(self) -> dict:
        enabled = self.is_central_server()
        return {
            "enabled": enabled,
            "ready": self.ready,
            "path": str(self.machine_export_path) if enabled else "",
            "revision": self.machine_export_revision,
            "exportedAt": self.machine_exported_at,
            "error": self.machine_export_error,
        }
    def refresh_machine_export(self) -> None:
        try:
            with self.lock:
                if not self.is_central_server() or not self.ready:
                    return
                with closing(self.connect()) as db:
                    row = db.execute(
                        "SELECT payload, revision FROM current_snapshot WHERE id = 1"
                    ).fetchone()
                snapshot = validate_snapshot(json.loads(row[0])) if row else dict(EMPTY_SNAPSHOT)
                revision = int(row[1]) if row else 0
                exported_at = datetime.now(timezone.utc).isoformat()
                export = {
                    "format": MACHINE_EXPORT_FORMAT,
                    "version": MACHINE_EXPORT_VERSION,
                    "exportedAt": exported_at,
                    "revision": revision,
                    "appointments": machine_export_value(snapshot["appointments"]),
                    "people": [
                        {
                            key: machine_export_value(value)
                            for key, value in person.items()
                            if key not in {"key", "_syncMeta"}
                        }
                        for person in snapshot["people"]
                    ],
                    "paaRecords": machine_export_value(snapshot["paaRecords"]),
                }
                export_path = self.machine_export_path
                export_path.parent.mkdir(parents=True, exist_ok=True)
                temporary_path = export_path.with_name(
                    f".{export_path.name}.{uuid.uuid4().hex}.tmp"
                )
                try:
                    with temporary_path.open("w", encoding="utf-8", newline="\n") as destination:
                        json.dump(export, destination, ensure_ascii=False, indent=2)
                        destination.write("\n")
                        destination.flush()
                        os.fsync(destination.fileno())
                    os.replace(temporary_path, export_path)
                finally:
                    try:
                        temporary_path.unlink()
                    except FileNotFoundError:
                        pass
                self.machine_export_revision = revision
                self.machine_exported_at = exported_at
                self.machine_export_error = ""
        except Exception as error:
            self.machine_export_error = str(error)
            logging.exception("Não foi possível atualizar o arquivo JSON externo do CRAS.")
    def register_user_credential(
        self,
        user_id: object,
        credential: object,
        display_name: object,
        role: object,
    ) -> None:
        validated_user_id, salt, password_hash = validate_user_credential(user_id, credential)
        if (
            not isinstance(display_name, str)
            or not display_name.strip()
            or len(display_name) > 100
            or not isinstance(role, str)
            or role not in VALID_USER_ROLES
        ):
            raise ValueError("O perfil do usuário está inválido.")
        with self.lock, closing(self.connect()) as db:
            with db:
                row = db.execute(
                    "SELECT salt, password_hash, display_name, role FROM user_credentials WHERE user_id = ?",
                    (validated_user_id,),
                ).fetchone()
                snapshot_row = db.execute(
                    "SELECT payload FROM current_snapshot WHERE id = 1"
                ).fetchone()
                snapshot_users = (
                    json.loads(snapshot_row[0])
                    .get("settings", {})
                    .get("cras-ouro-preto-usuarios-v1", [])
                    if snapshot_row
                    else []
                )
                if not isinstance(snapshot_users, list):
                    snapshot_users = []
                central_user = next(
                    (
                        user for user in snapshot_users
                        if isinstance(user, dict) and user.get("id") == validated_user_id
                    ),
                    None,
                )
                if central_user:
                    display_name = central_user.get("name", display_name)
                    role = central_user.get("role", role)
                    if (
                        not isinstance(display_name, str)
                        or not display_name.strip()
                        or not isinstance(role, str)
                        or role not in VALID_USER_ROLES
                    ):
                        raise ValueError("O perfil de usuário armazenado no servidor está inválido.")
                if row:
                    if row[0] != salt or row[1] != password_hash:
                        raise ValueError("Este usuário já possui uma senha cadastrada no servidor.")
                    if row[3] in VALID_USER_ROLES and not central_user:
                        role = row[3]
                    if isinstance(row[2], str) and row[2].strip() and not central_user:
                        display_name = row[2]
                    db.execute(
                        "UPDATE user_credentials SET display_name = ?, role = ? WHERE user_id = ?",
                        (display_name.strip(), role, validated_user_id),
                    )
                    return
                db.execute(
                    "INSERT INTO user_credentials "
                    "(user_id, salt, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)",
                    (validated_user_id, salt, password_hash, display_name.strip(), role),
                )
    def create_user_auth_challenge(self, user_id: object) -> dict | None:
        if not isinstance(user_id, str) or not user_id.strip() or len(user_id) > 100:
            raise ValueError("A identificação do usuário está inválida.")
        with self.lock, closing(self.connect()) as db:
            row = db.execute(
                "SELECT salt FROM user_credentials WHERE user_id = ?",
                (user_id.strip(),),
            ).fetchone()
        if not row:
            return None
        now = time.monotonic()
        challenge_id = secrets.token_urlsafe(32)
        nonce = secrets.token_urlsafe(32)
        with self.lock:
            self.user_auth_challenges = {
                key: value for key, value in self.user_auth_challenges.items()
                if value[2] > now
            }
            if len(self.user_auth_challenges) >= 256:
                self.user_auth_challenges.pop(next(iter(self.user_auth_challenges)))
            self.user_auth_challenges[challenge_id] = (
                user_id.strip(),
                nonce,
                now + 120,
            )
        return {"salt": str(row[0]), "challengeId": challenge_id, "nonce": nonce}
    def verify_user_auth_challenge(
        self,
        user_id: object,
        challenge_id: object,
        proof: object,
    ) -> bool:
        if (
            not isinstance(user_id, str)
            or not user_id.strip()
            or not isinstance(challenge_id, str)
            or not challenge_id
            or not isinstance(proof, str)
            or not re.fullmatch(r"[a-f0-9]{64}", proof, re.IGNORECASE)
        ):
            return False
        with self.lock:
            challenge = self.user_auth_challenges.pop(challenge_id, None)
            if (
                not challenge
                or challenge[0] != user_id.strip()
                or challenge[2] <= time.monotonic()
            ):
                return False
            password_hash = self.get_user_credential(user_id)
        if not password_hash:
            return False
        expected = user_authentication_proof(
            password_hash,
            user_id.strip(),
            challenge_id,
            challenge[1],
        )
        return hmac.compare_digest(expected, proof.lower())
    def user_auth_attempt_allowed(self, address: str) -> bool:
        now = time.monotonic()
        with self.lock:
            attempts = [
                attempt for attempt in self.user_auth_failures.get(address, [])
                if now - attempt < USER_AUTH_WINDOW_SECONDS
            ]
            if attempts:
                self.user_auth_failures[address] = attempts
            else:
                self.user_auth_failures.pop(address, None)
            return len(attempts) < USER_AUTH_MAX_ATTEMPTS
    def record_user_auth_attempt(self, address: str, failed: bool) -> None:
        with self.lock:
            if failed:
                self.user_auth_failures.setdefault(address, []).append(time.monotonic())
            else:
                self.user_auth_failures.pop(address, None)
    def get_user_credential(self, user_id: object) -> str | None:
        if not isinstance(user_id, str) or not user_id.strip() or len(user_id) > 100:
            return None
        with self.lock, closing(self.connect()) as db:
            row = db.execute(
                "SELECT password_hash FROM user_credentials WHERE user_id = ?",
                (user_id.strip(),),
            ).fetchone()
        return str(row[0]) if row else None
    def get_user_profile(self, user_id: object) -> dict | None:
        if not isinstance(user_id, str) or not user_id.strip() or len(user_id) > 100:
            return None
        with self.lock, closing(self.connect()) as db:
            row = db.execute(
                "SELECT display_name, role FROM user_credentials WHERE user_id = ?",
                (user_id.strip(),),
            ).fetchone()
        if not row or not isinstance(row[0], str) or row[1] not in VALID_USER_ROLES:
            return None
        return {"name": row[0], "role": row[1]}
    def set_principal(self, enabled: bool) -> None:
        if not isinstance(enabled, bool):
            raise ValueError("A configuração do computador principal é inválida.")
        with self.lock, closing(self.connect()) as db:
            with db:
                db.execute(
                    "UPDATE metadata SET value = ? WHERE key = 'is_principal'",
                    ("true" if enabled else "false",),
                )
    def is_principal(self) -> bool:
        with self.lock, closing(self.connect()) as db:
            row = db.execute(
                "SELECT value FROM metadata WHERE key = 'is_principal'"
            ).fetchone()
            return bool(row and row[0] == "true")
    def auto_backup_status(self) -> dict:
        directory = self.path.parent / "backups"
        backups = []
        if directory.exists():
            for path in directory.glob("cras-system-backup-*.json.gz"):
                try:
                    backups.append((path.stat().st_mtime, path))
                except FileNotFoundError:
                    continue
        backups.sort(key=lambda item: item[0], reverse=True)
        latest_backup = backups[0] if backups else None
        return {
            "enabled": self.is_principal(),
            "backup": latest_backup[1].name if latest_backup else "",
            "createdAt": (
                datetime.fromtimestamp(latest_backup[0])
                .astimezone()
                .isoformat()
                if latest_backup
                else ""
            ),
        }
    def create_transfer_package(self) -> Path:
        if not self.ready or not self.is_central_server():
            raise ValueError("Ative o servidor central antes de exportar o pacote de transferência.")
        directory = self.path.parent / "exports"
        directory.mkdir(parents=True, exist_ok=True)
        package_path = directory / f".cras-server-transfer-{uuid.uuid4().hex}.sqlite3"
        try:
            with self.lock, closing(self.connect()) as source, closing(
                sqlite3.connect(package_path)
            ) as destination:
                source.backup(destination)
            if package_path.stat().st_size > MAX_SERVER_TRANSFER_BYTES:
                raise ValueError("O pacote de transferência excede o limite de 256 MB.")
            return package_path
        except Exception:
            package_path.unlink(missing_ok=True)
            raise
    def restore_transfer_package(self, package_path: Path) -> int:
        with self.lock:
            if self.is_central_server():
                raise ValueError("Desative o servidor central atual antes de restaurar um pacote.")
            current_node_id = self.node_id
            staging_path = self.path.parent / f".cras-transfer-stage-{uuid.uuid4().hex}.sqlite3"
            try:
                with closing(sqlite3.connect(package_path)) as package:
                    integrity = package.execute("PRAGMA integrity_check").fetchone()
                    if not integrity or integrity[0] != "ok":
                        raise ValueError("O pacote de transferência está danificado.")
                    tables = {
                        row[0] for row in package.execute(
                            "SELECT name FROM sqlite_master WHERE type = 'table'"
                        ).fetchall()
                    }
                    required_tables = {
                        "metadata", "current_snapshot", "peer_bases",
                        "seen_requests", "chat_messages", "user_credentials"
                    }
                    if not required_tables.issubset(tables):
                        raise ValueError("O arquivo não contém um pacote completo de servidor CRAS.")
                    snapshot_row = package.execute(
                        "SELECT payload FROM current_snapshot WHERE id = 1"
                    ).fetchone()
                    metadata = dict(package.execute("SELECT key, value FROM metadata"))
                    if not snapshot_row or metadata.get("is_central_server") != "true":
                        raise ValueError("O pacote não foi exportado de um servidor central ativo.")
                    validate_snapshot(json.loads(snapshot_row[0]))
                    with closing(sqlite3.connect(staging_path)) as staged:
                        package.backup(staged)
                with closing(sqlite3.connect(staging_path)) as staged:
                    staged.execute(
                        "UPDATE metadata SET value = ? WHERE key = 'node_id'",
                        (current_node_id,),
                    )
                    staged.execute(
                        "UPDATE metadata SET value = 'true' WHERE key = 'is_central_server'"
                    )
                    staged.commit()
                with closing(sqlite3.connect(staging_path)) as source, closing(
                    self.connect()
                ) as destination:
                    source.backup(destination)
                with closing(self.connect()) as db:
                    revision_row = db.execute(
                        "SELECT revision FROM current_snapshot WHERE id = 1"
                    ).fetchone()
                    role_row = db.execute(
                        "SELECT value FROM metadata WHERE key = 'active_role'"
                    ).fetchone()
                self.node_id = current_node_id
                self.active_role = str(role_row[0]) if role_row else ""
                self.ready = True
                self.refresh_machine_export()
                return int(revision_row[0]) if revision_row else 0
            finally:
                try:
                    staging_path.unlink()
                except FileNotFoundError:
                    pass
    def create_auto_backup(self) -> Path | None:
        if not self.ready:
            return None
        directory = self.path.parent / "backups"
        directory.mkdir(parents=True, exist_ok=True)
        backup_name = f"cras-system-backup-{datetime.now().astimezone():%Y-%m-%d}.json.gz"
        backup_path = directory / backup_name
        if backup_path.exists():
            return backup_path

        state = self.get_local_state()
        snapshot = state["snapshot"]
        settings = snapshot["settings"]
        backup = {
            "format": "cras-ouro-preto-backup",
            "version": 1,
            "exportedAt": datetime.now(timezone.utc).isoformat(),
            "appointments": snapshot["appointments"],
            "people": snapshot["people"],
            "routes": settings.get("cras-ouro-preto-encaminhamentos-v1", []),
            "routeQueueTags": settings.get("cras-ouro-preto-encaminhamento-filas-v1", {}),
            "nationalities": settings.get("cras-ouro-preto-nacionalidades-v1", []),
            "assistants": settings.get("cras-ouro-preto-assistentes-v1", []),
            "users": settings.get("cras-ouro-preto-usuarios-v1", []),
            "paaRecords": snapshot["paaRecords"],
        }
        temporary_archive = directory / f".{backup_name}.tmp"
        try:
            with gzip.open(temporary_archive, "wt", encoding="utf-8", compresslevel=6) as destination:
                json.dump(backup, destination, ensure_ascii=False, separators=(",", ":"))
            os.replace(temporary_archive, backup_path)
        finally:
            try:
                temporary_archive.unlink()
            except FileNotFoundError:
                pass

        backups = sorted(directory.glob("cras-system-backup-*.json.gz"))
        for expired_backup in backups[:-AUTO_BACKUP_RETENTION]:
            expired_backup.unlink()
        return backup_path
    def store_chat_message(self, message: object) -> dict:
        validated = validate_chat_message(message)
        payload = canonical(validated)
        message_date = datetime.fromisoformat(validated["createdAt"])
        message_month = message_date.astimezone().strftime("%Y-%m")
        with self.lock, closing(self.connect()) as db:
            with db:
                row = db.execute(
                    "SELECT payload FROM chat_messages WHERE id = ?", (validated["id"],)
                ).fetchone()
                if row:
                    if row[0] != payload:
                        raise ValueError("O identificador da mensagem já está associado a outro conteúdo.")
                    return validated
                db.execute(
                    "INSERT INTO chat_messages "
                    "(id, created_at, month, payload, author_id, recipient_id) VALUES (?, ?, ?, ?, ?, ?)",
                    (
                        validated["id"],
                        validated["createdAt"],
                        message_month,
                        payload,
                        validated["authorId"],
                        validated.get("recipientId"),
                    ),
                )
        return validated
    def list_chat_messages(
        self,
        limit: int = 50,
        before: str = "",
        user_id: str | None = None,
        recipient_id: str | None = None,
    ) -> list[dict]:
        if not isinstance(limit, int) or not 1 <= limit <= 100:
            raise ValueError("A quantidade de mensagens solicitada é inválida.")
        if user_id is not None and (not isinstance(user_id, str) or not user_id.strip() or len(user_id) > 100):
            raise ValueError("O usuário da conversa é inválido.")
        if recipient_id is not None and (
            not isinstance(recipient_id, str)
            or not recipient_id.strip()
            or len(recipient_id) > 100
            or recipient_id == user_id
        ):
            raise ValueError("O destinatário da conversa é inválido.")
        if before:
            try:
                before = datetime.fromisoformat(before.replace("Z", "+00:00")).astimezone(
                    timezone.utc
                ).isoformat()
            except ValueError as error:
                raise ValueError("A data para carregar mensagens anteriores é inválida.") from error
        query = "SELECT payload FROM chat_messages"
        conditions = []
        parameters: tuple = ()
        if before:
            conditions.append("created_at < ?")
            parameters += (before,)
        if user_id is not None and recipient_id is None:
            conditions.append("recipient_id IS NULL")
        elif user_id is not None:
            conditions.append(
                "((author_id = ? AND recipient_id = ?) OR (author_id = ? AND recipient_id = ?))"
            )
            parameters += (user_id, recipient_id, recipient_id, user_id)
        if conditions:
            query += " WHERE " + " AND ".join(conditions)
        query += " ORDER BY created_at DESC, id DESC LIMIT ?"
        parameters += (limit,)
        with self.lock, closing(self.connect()) as db:
            rows = db.execute(query, parameters).fetchall()
        messages = [json.loads(row[0]) for row in reversed(rows)]
        for message in messages:
            if "attachment" in message:
                message["attachment"] = {
                    "name": message["attachment"]["name"],
                    "type": message["attachment"]["type"],
                }
        return messages
    def chat_attachment(
        self,
        message_id: str,
        user_id: str | None = None,
        recipient_id: str | None = None,
    ) -> tuple[str, bytes] | None:
        if not isinstance(message_id, str) or not message_id or len(message_id) > 100:
            raise ValueError("A identificação da imagem é inválida.")
        with self.lock, closing(self.connect()) as db:
            row = db.execute(
                "SELECT payload FROM chat_messages WHERE id = ?", (message_id,)
            ).fetchone()
        if not row:
            return None
        message = json.loads(row[0])
        target_id = message.get("recipientId")
        if user_id is not None:
            if target_id is None and recipient_id is not None:
                return None
            if target_id is not None and (
                recipient_id is None
                or not (
                    (message["authorId"] == user_id and target_id == recipient_id)
                    or (message["authorId"] == recipient_id and target_id == user_id)
                )
            ):
                return None
        attachment = message.get("attachment")
        if not attachment:
            return None
        return attachment["type"], base64.b64decode(attachment["data"], validate=True)
    def archive_old_chat_messages(self) -> list[Path]:
        with self.lock:
            return self._archive_old_chat_messages_locked()
    def _archive_old_chat_messages_locked(self) -> list[Path]:
        current_month = datetime.now().astimezone().strftime("%Y-%m")
        with self.lock, closing(self.connect()) as db:
            months = [
                row[0]
                for row in db.execute(
                    "SELECT DISTINCT month FROM chat_messages WHERE month < ? ORDER BY month",
                    (current_month,),
                ).fetchall()
            ]
        if not months:
            return []
        archive_directory = self.path.parent / "chat-backups"
        archive_directory.mkdir(parents=True, exist_ok=True)
        created_archives = []
        for month in months:
            with self.lock, closing(self.connect()) as db:
                rows = db.execute(
                    "SELECT id, created_at, payload FROM chat_messages WHERE month = ? ORDER BY created_at, id",
                    (month,),
                ).fetchall()
            messages = {row[0]: json.loads(row[2]) for row in rows}
            archive_path = archive_directory / f"cras-chat-backup-{month}.json.gz"
            if archive_path.exists():
                with gzip.open(archive_path, "rt", encoding="utf-8") as archive_file:
                    previous_messages = json.load(archive_file)
                if not isinstance(previous_messages, list):
                    raise ValueError(f"O backup do chat de {month} está inválido.")
                for message in previous_messages:
                    validated = validate_chat_message(message)
                    messages.setdefault(validated["id"], validated)
            temporary_path = archive_path.with_name(f".{archive_path.name}.tmp")
            try:
                with gzip.open(temporary_path, "wt", encoding="utf-8") as archive_file:
                    json.dump(
                        [messages[key] for key in sorted(messages)],
                        archive_file,
                        ensure_ascii=False,
                        separators=(",", ":"),
                    )
                os.replace(temporary_path, archive_path)
            finally:
                try:
                    temporary_path.unlink()
                except FileNotFoundError:
                    pass
            with self.lock, closing(self.connect()) as db:
                with db:
                    db.execute("DELETE FROM chat_messages WHERE month = ?", (month,))
            created_archives.append(archive_path)
        return created_archives
    def configure_mobile_access(self, password: str) -> None:
        with self.lock, closing(self.connect()) as db:
            with db:
                if not password:
                    db.execute(
                        "DELETE FROM metadata WHERE key IN ('mobile_access_salt', 'mobile_access_key')"
                    )
                    return
                if not isinstance(password, str) or not (
                    MOBILE_ACCESS_MIN_LENGTH <= len(password) <= 128
                ):
                    raise ValueError(
                        f"O código móvel deve ter entre {MOBILE_ACCESS_MIN_LENGTH} e 128 caracteres."
                    )
                salt = secrets.token_bytes(16)
                key = derive_mobile_access_key(password, salt)
                db.execute(
                    "INSERT INTO metadata (key, value) VALUES ('mobile_access_salt', ?) "
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    (base64.b64encode(salt).decode("ascii"),),
                )
                db.execute(
                    "INSERT INTO metadata (key, value) VALUES ('mobile_access_key', ?) "
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    (base64.b64encode(key).decode("ascii"),),
                )
    def mobile_access_info(self) -> dict:
        with self.lock, closing(self.connect()) as db:
            row = db.execute(
                "SELECT value FROM metadata WHERE key = 'mobile_access_salt'"
            ).fetchone()
            return {
                "enabled": row is not None,
                "salt": str(row[0]) if row else "",
                "iterations": MOBILE_ACCESS_ITERATIONS,
                "minLength": MOBILE_ACCESS_MIN_LENGTH,
            }
    def mobile_access_key(self) -> bytes | None:
        with self.lock, closing(self.connect()) as db:
            row = db.execute(
                "SELECT value FROM metadata WHERE key = 'mobile_access_key'"
            ).fetchone()
            return base64.b64decode(row[0], validate=True) if row else None
    def get_local_state(self) -> dict:
        with self.lock, closing(self.connect()) as db:
            row = db.execute("SELECT payload, revision FROM current_snapshot WHERE id = 1").fetchone()
            peer_rows = db.execute("SELECT peer_id, payload FROM peer_bases").fetchall()
            return {
                "snapshot": validate_snapshot(json.loads(row[0])) if row else dict(EMPTY_SNAPSHOT),
                "revision": int(row[1]) if row else 0,
                "ready": self.ready,
                "peerSettings": {
                    peer_id: json.loads(payload).get("settings", {})
                    for peer_id, payload in peer_rows
                },
                "actorRole": self.active_role if self.active_role in VALID_USER_ROLES else None,
            }
    def get_revision(self) -> int:
        with self.lock, closing(self.connect()) as db:
            row = db.execute("SELECT revision FROM current_snapshot WHERE id = 1").fetchone()
            return int(row[0]) if row else 0
    def save_local_snapshot(
        self, snapshot: object, expected_revision: object, actor_role: object = None
    ) -> int:
        people_supplied = isinstance(snapshot, dict) and "people" in snapshot
        valid_snapshot = validate_snapshot(snapshot)
        if actor_role is not None and (
            not isinstance(actor_role, str) or actor_role not in VALID_USER_ROLES
        ):
            raise ValueError("O perfil do usuário local é inválido.")
        with self.lock, closing(self.connect()) as db:
            with db:
                row = db.execute("SELECT payload, revision FROM current_snapshot WHERE id = 1").fetchone()
                current_snapshot = validate_snapshot(json.loads(row[0])) if row else dict(EMPTY_SNAPSHOT)
                current_e2ee = technical_e2ee_enabled(current_snapshot)
                incoming_e2ee = technical_e2ee_enabled(valid_snapshot)
                if current_e2ee and not incoming_e2ee:
                    raise ValueError(
                        "Este computador ainda não usa a criptografia técnica. Atualize o CRAS Desktop e sincronize novamente."
                    )
                if current_e2ee and (
                    current_snapshot["settings"][TECHNICAL_E2EE_SETTING]["keyCheck"]
                    != valid_snapshot["settings"][TECHNICAL_E2EE_SETTING]["keyCheck"]
                ):
                    raise ValueError("A chave de criptografia técnica deste computador não corresponde ao servidor.")
                current_revision = int(row[1]) if row else 0
                if expected_revision != current_revision:
                    raise RevisionConflict(current_revision)
                if not people_supplied:
                    valid_snapshot["people"] = current_snapshot["people"]
                self.preserve_person_fields(valid_snapshot, current_snapshot)
                central_row = db.execute(
                    "SELECT value FROM metadata WHERE key = 'is_central_server'"
                ).fetchone()
                self.ensure_people_snapshot(
                    db, valid_snapshot, bool(central_row and central_row[0] == "true")
                )
                db.execute(
                    "UPDATE current_snapshot SET payload = ?, revision = revision + 1 WHERE id = 1",
                    (canonical(valid_snapshot),),
                )
                if incoming_e2ee and not current_e2ee:
                    db.execute("UPDATE peer_bases SET payload = ?", (canonical(valid_snapshot),))
                if actor_role is not None:
                    db.execute(
                        "UPDATE metadata SET value = ? WHERE key = 'active_role'",
                        (actor_role,),
                    )
                    self.active_role = actor_role
                row = db.execute("SELECT revision FROM current_snapshot WHERE id = 1").fetchone()
                self.ready = True
                revision = int(row[0])
        self.refresh_machine_export()
        return revision
    def accept_synced_snapshot(
        self,
        peer_id: str,
        snapshot: object,
        peer_base: object,
        expected_revision: object,
        actor_role: object = None,
    ) -> int:
        if not isinstance(peer_id, str) or not peer_id.strip() or len(peer_id) > 100:
            raise ValueError("Identificação do computador remoto inválida.")
        people_supplied = isinstance(snapshot, dict) and "people" in snapshot
        valid_snapshot = validate_snapshot(snapshot)
        valid_peer_base = validate_snapshot(peer_base)
        if actor_role is not None and (
            not isinstance(actor_role, str) or actor_role not in VALID_USER_ROLES
        ):
            raise ValueError("O perfil do usuário local é inválido.")
        payload = canonical(valid_snapshot)
        with self.lock, closing(self.connect()) as db:
            with db:
                row = db.execute("SELECT payload, revision FROM current_snapshot WHERE id = 1").fetchone()
                current_snapshot = validate_snapshot(json.loads(row[0])) if row else dict(EMPTY_SNAPSHOT)
                current_e2ee = technical_e2ee_enabled(current_snapshot)
                incoming_e2ee = technical_e2ee_enabled(valid_snapshot)
                if current_e2ee and not incoming_e2ee:
                    raise ValueError(
                        "Este computador ainda não usa a criptografia técnica. Atualize o CRAS Desktop e sincronize novamente."
                    )
                if current_e2ee and (
                    current_snapshot["settings"][TECHNICAL_E2EE_SETTING]["keyCheck"]
                    != valid_snapshot["settings"][TECHNICAL_E2EE_SETTING]["keyCheck"]
                ):
                    raise ValueError("A chave de criptografia técnica deste computador não corresponde ao servidor.")
                current_revision = int(row[1]) if row else 0
                if expected_revision != current_revision:
                    raise RevisionConflict(current_revision)
                if not people_supplied:
                    valid_snapshot["people"] = current_snapshot["people"]
                self.preserve_person_fields(valid_snapshot, current_snapshot)
                central_row = db.execute(
                    "SELECT value FROM metadata WHERE key = 'is_central_server'"
                ).fetchone()
                self.ensure_people_snapshot(
                    db, valid_snapshot, bool(central_row and central_row[0] == "true")
                )
                payload = canonical(valid_snapshot)
                db.execute(
                    "UPDATE current_snapshot SET payload = ?, revision = revision + 1 WHERE id = 1",
                    (payload,),
                )
                if incoming_e2ee and not current_e2ee:
                    db.execute("UPDATE peer_bases SET payload = ?", (payload,))
                if incoming_e2ee:
                    valid_peer_base = valid_snapshot
                db.execute(
                    "INSERT INTO peer_bases (peer_id, payload) VALUES (?, ?) "
                    "ON CONFLICT(peer_id) DO UPDATE SET payload = excluded.payload",
                    (peer_id, canonical(valid_peer_base)),
                )
                if actor_role is not None:
                    db.execute(
                        "UPDATE metadata SET value = ? WHERE key = 'active_role'",
                        (actor_role,),
                    )
                    self.active_role = actor_role
                row = db.execute("SELECT revision FROM current_snapshot WHERE id = 1").fetchone()
                self.ready = True
                revision = int(row[0])
        self.refresh_machine_export()
        return revision
    def sync(
        self,
        peer_id: str,
        request_id: str,
        local_snapshot: object,
        resolutions: object,
        peer_role: object = None,
    ) -> dict:
        if not self.ready:
            raise ValueError("O outro computador ainda está inicializando. Tente sincronizar novamente em instantes.")
        if not isinstance(peer_id, str) or not peer_id.strip() or len(peer_id) > 100:
            raise ValueError("Identificação do computador remoto inválida.")
        if not isinstance(request_id, str) or not request_id.strip() or len(request_id) > 100:
            raise ValueError("Identificação da solicitação inválida.")
        people_supplied = isinstance(local_snapshot, dict) and "people" in local_snapshot
        local = validate_snapshot(local_snapshot)
        if not isinstance(resolutions, dict):
            raise ValueError("As resoluções de conflito estão inválidas.")
        if peer_role is not None and (
            not isinstance(peer_role, str) or peer_role not in VALID_USER_ROLES
        ):
            raise ValueError("O perfil do computador remoto é inválido.")
        with self.lock, closing(self.connect()) as db:
            with db:
                if db.execute(
                    "SELECT 1 FROM seen_requests WHERE peer_id = ? AND request_id = ?",
                    (peer_id, request_id),
                ).fetchone():
                    raise ValueError("Solicitação de sincronização repetida; inicie uma nova sincronização.")
                row = db.execute("SELECT payload FROM current_snapshot WHERE id = 1").fetchone()
                remote = validate_snapshot(json.loads(row[0])) if row else dict(EMPTY_SNAPSHOT)
                remote_e2ee = technical_e2ee_enabled(remote)
                local_e2ee = technical_e2ee_enabled(local)
                if remote_e2ee and not local_e2ee:
                    raise ValueError(
                        "Este computador ainda não usa a criptografia técnica. Atualize o CRAS Desktop e sincronize novamente."
                    )
                if remote_e2ee and (
                    remote["settings"][TECHNICAL_E2EE_SETTING]["keyCheck"]
                    != local["settings"][TECHNICAL_E2EE_SETTING]["keyCheck"]
                ):
                    raise ValueError("A chave de criptografia técnica deste posto não corresponde ao servidor.")
                base_row = db.execute("SELECT payload FROM peer_bases WHERE peer_id = ?", (peer_id,)).fetchone()
                base = validate_snapshot(json.loads(base_row[0])) if base_row else dict(EMPTY_SNAPSHOT)
                if local_e2ee and not remote_e2ee:
                    if peer_role != "assistant":
                        raise ValueError(
                            "Somente uma conta de Técnica pode ativar a criptografia das anotações técnicas."
                        )
                    remote_ids = {item["id"] for item in remote["appointments"]}
                    local_ids = {item["id"] for item in local["appointments"]}
                    if not remote_ids.issubset(local_ids):
                        raise ValueError(
                            "Sincronize este posto com os dados atuais antes de ativar a criptografia técnica."
                        )
                merged = {
                    "appointments": self.merge_collection(
                        "appointments", base, local, remote, peer_role, self.active_role
                    ),
                    "people": self.merge_collection(
                        "people", base, local, remote, peer_role, self.active_role
                    ) if people_supplied else remote["people"],
                    "paaRecords": self.merge_collection(
                        "paaRecords", base, local, remote, peer_role, self.active_role
                    ),
                    "settings": self.merge_settings(
                        base, local, remote, peer_role, self.active_role
                    ),
                }
                if local_e2ee and not remote_e2ee:
                    encrypted_by_id = {
                        item["id"]: item["technicalAnnotationsCiphertext"]
                        for item in local["appointments"]
                        if "technicalAnnotationsCiphertext" in item
                    }
                    for record in merged["appointments"]:
                        if record["id"] in encrypted_by_id:
                            record["technicalAnnotationsCiphertext"] = encrypted_by_id[record["id"]]
                        else:
                            record.pop("technicalAnnotationsCiphertext", None)
                        annotations = record.get("annotations", {})
                        record["annotations"] = {
                            **annotations,
                            "assistencia": [],
                        }
                if remote_e2ee and peer_role != "assistant":
                    remote_by_id = {item["id"]: item for item in remote["appointments"]}
                    merged_by_id = {item["id"]: item for item in merged["appointments"]}
                    for record_id, merged_record in merged_by_id.items():
                        remote_record = remote_by_id.get(record_id)
                        ciphertext = (
                            remote_record.get("technicalAnnotationsCiphertext")
                            if remote_record
                            else None
                        )
                        if not ciphertext:
                            merged_record.pop("technicalAnnotationsCiphertext", None)
                            continue
                        merged_record["technicalAnnotationsCiphertext"] = ciphertext
                        annotations = merged_record.get("annotations", {})
                        merged_record["annotations"] = {**annotations, "assistencia": []}
                    for record_id, remote_record in remote_by_id.items():
                        if (
                            remote_record.get("technicalAnnotationsCiphertext")
                            and record_id not in merged_by_id
                        ):
                            merged["appointments"].append(remote_record)
                self.preserve_person_fields(merged, remote)
                central_row = db.execute(
                    "SELECT value FROM metadata WHERE key = 'is_central_server'"
                ).fetchone()
                self.ensure_people_snapshot(
                    db, merged, bool(central_row and central_row[0] == "true")
                )
                central_users = merged["settings"].get("cras-ouro-preto-usuarios-v1", [])
                if isinstance(central_users, list):
                    profiles = {
                        user["id"]: (user["name"], user["role"])
                        for user in central_users
                        if isinstance(user, dict)
                        and isinstance(user.get("id"), str)
                        and isinstance(user.get("name"), str)
                        and isinstance(user.get("role"), str)
                        and user.get("role") in VALID_USER_ROLES
                    }
                    for user_id, (display_name, role) in profiles.items():
                        db.execute(
                            "UPDATE user_credentials SET display_name = ?, role = ? WHERE user_id = ?",
                            (display_name, role, user_id),
                        )
                validate_snapshot(merged)
                payload = canonical(merged)
                db.execute(
                    "UPDATE current_snapshot SET payload = ?, revision = revision + 1 WHERE id = 1",
                    (payload,),
                )
                if local_e2ee and not remote_e2ee:
                    db.execute("UPDATE peer_bases SET payload = ?", (payload,))
                db.execute(
                    "INSERT INTO peer_bases (peer_id, payload) VALUES (?, ?) "
                    "ON CONFLICT(peer_id) DO UPDATE SET payload = excluded.payload",
                    (peer_id, payload),
                )
                db.execute(
                    "INSERT INTO seen_requests (peer_id, request_id) VALUES (?, ?)",
                    (peer_id, request_id),
                )
                revision = db.execute("SELECT revision FROM current_snapshot WHERE id = 1").fetchone()[0]
                result = {
                    "status": "ok",
                    "snapshot": merged,
                    "revision": revision,
                    "syncedAt": datetime.now(timezone.utc).isoformat(),
                    "actorRole": self.active_role if self.active_role in VALID_USER_ROLES else None,
                    "unlinkedPaaIds": [],
                }
        self.refresh_machine_export()
        return result
    @staticmethod
    def merge_collection(
        name: str,
        base: dict,
        local: dict,
        remote: dict,
        local_role: object = None,
        remote_role: object = None,
    ) -> list[dict]:
        identity_field = "key" if name == "people" else "id"
        base_items = {item[identity_field]: item for item in base.get(name, [])}
        local_items = {item[identity_field]: item for item in local[name]}
        remote_items = {item[identity_field]: item for item in remote[name]}
        merged: list[dict] = []
        for item_id in sorted(base_items.keys() | local_items.keys() | remote_items.keys()):
            base_value = base_items.get(item_id, MISSING)
            local_value = local_items.get(item_id, MISSING)
            remote_value = remote_items.get(item_id, MISSING)
            value = PeerStore.merge_value(
                base_value,
                local_value,
                remote_value,
                name,
                item_id,
                local_role,
                remote_role,
                PeerStore.sync_metadata(local_value),
                PeerStore.sync_metadata(remote_value),
            )
            if value is not MISSING:
                merged.append(value)
        return merged
    @staticmethod
    def merge_settings(
        base: dict,
        local: dict,
        remote: dict,
        local_role: object = None,
        remote_role: object = None,
    ) -> dict:
        base_settings = base.get("settings", {})
        local_settings = local["settings"]
        remote_settings = remote["settings"]
        merged: dict = {}
        for key in sorted(base_settings.keys() | local_settings.keys() | remote_settings.keys()):
            value = PeerStore.merge_value(
                base_settings.get(key, MISSING),
                local_settings.get(key, MISSING),
                remote_settings.get(key, MISSING),
                "settings",
                key,
                local_role,
                remote_role,
            )
            if value is not MISSING:
                merged[key] = value
        return merged
    @staticmethod
    def merge_value(
        base: object,
        local: object,
        remote: object,
        collection: str,
        path: str,
        local_role: object,
        remote_role: object,
        local_meta: dict | None = None,
        remote_meta: dict | None = None,
    ) -> object:
        def equal(left: object, right: object) -> bool:
            if left is MISSING or right is MISSING:
                return left is right
            return canonical(left) == canonical(right)
        if equal(local, remote):
            return remote
        if equal(local, base):
            return remote
        if equal(remote, base):
            return local
        if isinstance(local, dict) and isinstance(remote, dict):
            base_mapping = base if isinstance(base, dict) else {}
            merged: dict = {}
            keys = base_mapping.keys() | local.keys() | remote.keys()
            for key in sorted(keys - {"_syncMeta"}):
                value = PeerStore.merge_value(
                    base_mapping.get(key, MISSING),
                    local.get(key, MISSING),
                    remote.get(key, MISSING),
                    collection,
                    f"{path}.{key}",
                    local_role,
                    remote_role,
                    PeerStore.sync_metadata(local) or local_meta,
                    PeerStore.sync_metadata(remote) or remote_meta,
                )
                if value is not MISSING:
                    merged[key] = value
            if "_syncMeta" in keys:
                metadata = PeerStore.merge_sync_metadata(
                    base_mapping.get("_syncMeta"),
                    local.get("_syncMeta"),
                    remote.get("_syncMeta"),
                )
                if metadata is not None:
                    merged["_syncMeta"] = metadata
            return merged
        if (
            isinstance(local, list)
            and isinstance(remote, list)
            and all(isinstance(item, dict) and isinstance(item.get("id"), str) for item in local + remote)
        ):
            base_items = {
                item["id"]: item for item in base
                if isinstance(item, dict) and isinstance(item.get("id"), str)
            } if isinstance(base, list) else {}
            local_items = {item["id"]: item for item in local}
            remote_items = {item["id"]: item for item in remote}
            merged_items = []
            for item_id in sorted(base_items.keys() | local_items.keys() | remote_items.keys()):
                value = PeerStore.merge_value(
                    base_items.get(item_id, MISSING),
                    local_items.get(item_id, MISSING),
                    remote_items.get(item_id, MISSING),
                    collection,
                    f"{path}.{item_id}",
                    local_role,
                    remote_role,
                    PeerStore.sync_metadata(local_items[item_id]) or local_meta
                    if item_id in local_items else local_meta,
                    PeerStore.sync_metadata(remote_items[item_id]) or remote_meta
                    if item_id in remote_items else remote_meta,
                )
                if value is not MISSING:
                    merged_items.append(value)
            return merged_items
        return local if PeerStore.local_has_precedence(
            collection, path, local_meta, remote_meta, local_role, remote_role
        ) else remote
    @staticmethod
    def sync_metadata(value: object) -> dict | None:
        if not isinstance(value, dict):
            return None
        metadata = value.get("_syncMeta")
        return metadata if isinstance(metadata, dict) else None
    @staticmethod
    def local_has_precedence(
        collection: str,
        path: str,
        local_meta: dict | None,
        remote_meta: dict | None,
        local_role: object,
        remote_role: object,
    ) -> bool:
        def metadata_role(metadata: dict | None, fallback: object) -> object:
            if not isinstance(metadata, dict):
                return fallback
            if collection == "appointments":
                queue = "assistencia" if "technicalAnnotationsCiphertext" in path else next(
                    (name for name in ("assistencia", "cadastro") if f".{name}" in f".{path}"),
                    None,
                )
                if queue:
                    queues = metadata.get("queues")
                    queue_meta = queues.get(queue) if isinstance(queues, dict) else None
                    if isinstance(queue_meta, dict) and queue_meta.get("role") in VALID_USER_ROLES:
                        return queue_meta["role"]
            last_change = metadata.get("last")
            if isinstance(last_change, dict) and last_change.get("role") in VALID_USER_ROLES:
                return last_change["role"]
            return fallback
        local_actor = metadata_role(local_meta, local_role)
        remote_actor = metadata_role(remote_meta, remote_role)
        def priority(role: object) -> int:
            if role == "admin":
                return 100
            if collection == "appointments":
                if ".assistencia" in f".{path}" or ".cadastro" in f".{path}":
                    queue = "assistencia" if ".assistencia" in f".{path}" else "cadastro"
                    preferred_role = "assistant" if queue == "assistencia" else "caseworker"
                    if role in {"reception", "intern"}:
                        return 90
                    return 80 if role == preferred_role else 10
                if ".routeServices" in f".{path}" and role in {"reception", "intern"}:
                    return 90
                return 80 if role in {"reception", "intern"} else 10
            if collection == "paaRecords":
                return 80 if role in {"reception", "intern"} else 10
            return 10
        local_priority = priority(local_actor)
        remote_priority = priority(remote_actor)
        return local_priority > remote_priority
    @staticmethod
    def merge_sync_metadata(base: object, local: object, remote: object) -> object:
        base_meta = base if isinstance(base, dict) else {}
        local_meta = local if isinstance(local, dict) else {}
        remote_meta = remote if isinstance(remote, dict) else {}
        def merge_nodes(local_node: object, remote_node: object) -> object:
            if isinstance(local_node, dict) and isinstance(remote_node, dict):
                if "updatedAt" in local_node or "updatedAt" in remote_node:
                    return (
                        local_node
                        if local_node.get("updatedAt", "") > remote_node.get("updatedAt", "")
                        else remote_node
                    )
                return {
                    key: merge_nodes(local_node.get(key), remote_node.get(key))
                    if key in local_node and key in remote_node
                    else local_node.get(key, remote_node.get(key))
                    for key in local_node.keys() | remote_node.keys()
                }
            return remote_node if remote_node is not None else local_node
        merged: dict = {}
        keys = base_meta.keys() | local_meta.keys() | remote_meta.keys()
        for key in keys:
            base_value = base_meta.get(key)
            local_value = local_meta.get(key)
            remote_value = remote_meta.get(key)
            if canonical(local_value) == canonical(remote_value):
                value = remote_value
            elif canonical(local_value) == canonical(base_value):
                value = remote_value
            elif canonical(remote_value) == canonical(base_value):
                value = local_value
            else:
                value = merge_nodes(local_value, remote_value)
            if value is not None:
                merged[key] = value
        return merged

# Cache global para a resolução de endereços IP da rede

_LAN_ADDRESSES_CACHE: list[str] | None = None
_LAN_ADDRESSES_CACHE_TIME: float = 0.0
_LAN_CACHE_LOCK = threading.Lock()

# OTIMIZAÇÃO 3: Cache para evitar chamadas de socket síncronas pesadas repetidamente

def windows_interface_addresses() -> list[str]:
    if os.name != "nt":
        return []

    class SocketAddress(ctypes.Structure):
        _fields_ = [("address", ctypes.c_void_p), ("length", ctypes.c_int)]

    class AdapterUnicastAddress(ctypes.Structure):
        _fields_ = [
            ("length", ctypes.c_ulong),
            ("flags", ctypes.c_ulong),
            ("next", ctypes.c_void_p),
            ("address", SocketAddress),
            ("prefix_origin", ctypes.c_int),
            ("suffix_origin", ctypes.c_int),
            ("dad_state", ctypes.c_int),
            ("valid_lifetime", ctypes.c_ulong),
            ("preferred_lifetime", ctypes.c_ulong),
            ("lease_lifetime", ctypes.c_ulong),
            ("on_link_prefix_length", ctypes.c_ubyte),
        ]

    class AdapterAddresses(ctypes.Structure):
        _fields_ = [
            ("length", ctypes.c_ulong),
            ("if_index", ctypes.c_ulong),
            ("next", ctypes.c_void_p),
            ("adapter_name", ctypes.c_void_p),
            ("first_unicast_address", ctypes.c_void_p),
            ("first_anycast_address", ctypes.c_void_p),
            ("first_multicast_address", ctypes.c_void_p),
            ("first_dns_server_address", ctypes.c_void_p),
            ("dns_suffix", ctypes.c_void_p),
            ("description", ctypes.c_void_p),
            ("friendly_name", ctypes.c_void_p),
            ("physical_address", ctypes.c_ubyte * 8),
            ("physical_address_length", ctypes.c_ulong),
            ("flags", ctypes.c_ulong),
            ("mtu", ctypes.c_ulong),
            ("if_type", ctypes.c_ulong),
            ("oper_status", ctypes.c_int),
        ]

    ip_helper = ctypes.WinDLL("iphlpapi.dll")
    get_adapters_addresses = ip_helper.GetAdaptersAddresses
    get_adapters_addresses.argtypes = [
        ctypes.c_ulong,
        ctypes.c_ulong,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_ulong),
    ]
    get_adapters_addresses.restype = ctypes.c_ulong
    buffer_size = ctypes.c_ulong(0)
    result = get_adapters_addresses(2, 0x2 | 0x4 | 0x8, None, None, ctypes.byref(buffer_size))
    if result not in (0, 111):
        raise OSError(result, "Não foi possível consultar os adaptadores de rede do Windows.")
    if not buffer_size.value:
        return []

    buffer = ctypes.create_string_buffer(buffer_size.value)
    result = get_adapters_addresses(
        2, 0x2 | 0x4 | 0x8, None, ctypes.byref(buffer), ctypes.byref(buffer_size)
    )
    if result:
        raise OSError(result, "Não foi possível enumerar os adaptadores de rede do Windows.")

    addresses = set()
    adapter = ctypes.cast(buffer, ctypes.POINTER(AdapterAddresses))
    while adapter:
        if adapter.contents.oper_status == 1:
            unicast = ctypes.cast(
                adapter.contents.first_unicast_address,
                ctypes.POINTER(AdapterUnicastAddress),
            )
            while unicast:
                address = unicast.contents.address.address
                if address:
                    sockaddr = ctypes.cast(address, ctypes.POINTER(ctypes.c_ushort))
                    if sockaddr.contents.value == socket.AF_INET:
                        raw_address = ctypes.string_at(address + 4, 4)
                        ip = str(ipaddress.IPv4Address(raw_address))
                        parsed = ipaddress.IPv4Address(ip)
                        if not (
                            parsed.is_loopback
                            or parsed.is_link_local
                            or parsed.is_unspecified
                            or parsed.is_multicast
                        ):
                            addresses.add(ip)
                next_address = unicast.contents.next
                unicast = (
                    ctypes.cast(next_address, ctypes.POINTER(AdapterUnicastAddress))
                    if next_address
                    else None
                )
        next_adapter = adapter.contents.next
        adapter = (
            ctypes.cast(next_adapter, ctypes.POINTER(AdapterAddresses))
            if next_adapter
            else None
        )
    return sorted(addresses)


def lan_addresses() -> list[str]:
    global _LAN_ADDRESSES_CACHE, _LAN_ADDRESSES_CACHE_TIME
    now = time.monotonic()
    with _LAN_CACHE_LOCK:
        if _LAN_ADDRESSES_CACHE is not None and (now - _LAN_ADDRESSES_CACHE_TIME < 30.0):
            return _LAN_ADDRESSES_CACHE
    results: set[str] = set()
    primary_address = ""
    try:
        results.update(windows_interface_addresses())
    except (OSError, AttributeError):
        logging.exception("Não foi possível enumerar os endereços das interfaces de rede.")
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("8.8.8.8", 80))
            address = probe.getsockname()[0]
            if not address.startswith("127.") and not address.startswith("169.254."):
                primary_address = address
                results.add(address)
    except OSError:
        pass
    try:
        for item in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            address = item[4][0]
            if not address.startswith("127.") and not address.startswith("169.254."):
                results.add(address)
    except OSError:
        logging.exception("Não foi possível detectar os endereços da rede local.")
    try:
        _, _, ip_list = socket.gethostbyname_ex(socket.gethostname())
        for address in ip_list:
            if not address.startswith("127.") and not address.startswith("169.254."):
                results.add(address)
    except OSError:
        pass
    results = {
        address
        for address in results
        if is_valid_local_ipv4(ipaddress.IPv4Address(address))
    }
    if primary_address not in results:
        primary_address = ""
    remaining = sorted(results - {primary_address})
    final_addresses = ([primary_address] if primary_address else []) + remaining
    with _LAN_CACHE_LOCK:
        _LAN_ADDRESSES_CACHE = final_addresses
        _LAN_ADDRESSES_CACHE_TIME = now
    return final_addresses
def ensure_mobile_tls_certificates(
    directory: Path,
    addresses: list[str],
    hostname: str = "",
) -> tuple[Path, Path, Path, str]:
    directory.mkdir(parents=True, exist_ok=True)
    ca_key_path = directory / "mobile-root-ca.key"
    ca_cert_path = directory / "mobile-root-ca.crt"
    server_key_path = directory / "mobile-server.key"
    server_cert_path = directory / "mobile-server.crt"
    ca_exists = ca_key_path.exists(), ca_cert_path.exists()
    if any(ca_exists) and not all(ca_exists):
        raise ValueError("Os arquivos da autoridade certificadora móvel estão incompletos.")
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    if all(ca_exists):
        ca_key = serialization.load_pem_private_key(ca_key_path.read_bytes(), password=None)
        ca_cert = x509.load_pem_x509_certificate(ca_cert_path.read_bytes())
        key_public = ca_key.public_key().public_bytes(
            serialization.Encoding.DER,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        cert_public = ca_cert.public_key().public_bytes(
            serialization.Encoding.DER,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        if key_public != cert_public or not ca_cert.extensions.get_extension_for_class(
            x509.BasicConstraints
        ).value.ca:
            raise ValueError("A autoridade certificadora móvel não corresponde à chave privada.")
        try:
            ca_cert.extensions.get_extension_for_class(x509.SubjectKeyIdentifier)
        except x509.ExtensionNotFound:
            ca_ski = x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key())
            ca_cert = (
                x509.CertificateBuilder()
                .subject_name(ca_cert.subject)
                .issuer_name(ca_cert.issuer)
                .public_key(ca_key.public_key())
                .serial_number(x509.random_serial_number())
                .not_valid_before(now - timedelta(days=1))
                .not_valid_after(now + timedelta(days=3650))
                .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
                .add_extension(ca_ski, critical=False)
                .add_extension(
                    x509.KeyUsage(
                        digital_signature=True,
                        content_commitment=False,
                        key_encipherment=False,
                        data_encipherment=False,
                        key_agreement=False,
                        key_cert_sign=True,
                        crl_sign=True,
                        encipher_only=False,
                        decipher_only=False,
                    ),
                    critical=True,
                )
                .sign(ca_key, hashes.SHA256())
            )
            ca_cert_path.write_bytes(ca_cert.public_bytes(serialization.Encoding.PEM))
    else:
        ca_key = ec.generate_private_key(ec.SECP256R1())
        ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "CRAS Desktop Mobile CA")])
        ca_ski = x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key())
        ca_cert = (
            x509.CertificateBuilder()
            .subject_name(ca_name)
            .issuer_name(ca_name)
            .public_key(ca_key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(days=1))
            .not_valid_after(now + timedelta(days=3650))
.add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
.add_extension(ca_ski, critical=False)
            .add_extension(
                x509.KeyUsage(
                    digital_signature=True,
                    content_commitment=False,
                    key_encipherment=False,
                    data_encipherment=False,
                    key_agreement=False,
                    key_cert_sign=True,
                    crl_sign=True,
                    encipher_only=False,
                    decipher_only=False,
                ),
                critical=True,
            )
            .sign(ca_key, hashes.SHA256())
        )
        ca_key_path.write_bytes(ca_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ))
        ca_cert_path.write_bytes(ca_cert.public_bytes(serialization.Encoding.PEM))
    server_key = ec.generate_private_key(ec.SECP256R1())
    server_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "CRAS Desktop Local")])
    subject_alt_names = [x509.DNSName("localhost")]
    if hostname:
        subject_alt_names.append(x509.DNSName(hostname))
    for address in sorted(set(addresses) | {"127.0.0.1"}):
        subject_alt_names.append(x509.IPAddress(ipaddress.ip_address(address)))
    server_ski = x509.SubjectKeyIdentifier.from_public_key(server_key.public_key())
    server_aki = x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key())
    server_cert = (
        x509.CertificateBuilder()
        .subject_name(server_name)
        .issuer_name(ca_cert.subject)
        .public_key(server_key.public_key())
        .serial_number(x509.random_serial_number())
.not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + timedelta(days=365))
        .add_extension(x509.SubjectAlternativeName(subject_alt_names), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]),
            critical=False,
        )
        .add_extension(server_ski, critical=False)
        .add_extension(server_aki, critical=False)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=False,
                crl_sign=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .sign(ca_key, hashes.SHA256())
    )
    server_key_path.write_bytes(server_key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ))
    server_cert_path.write_bytes(server_cert.public_bytes(serialization.Encoding.PEM))
    fingerprint = ":".join(f"{byte:02X}" for byte in ca_cert.fingerprint(hashes.SHA256()))
    return ca_cert_path, server_cert_path, server_key_path, fingerprint
def mobile_tls_context(certificate_path: Path, private_key_path: Path) -> ssl.SSLContext:
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(str(certificate_path), str(private_key_path))
    return context
class CRASRequestHandler(BaseHTTPRequestHandler):
    store: PeerStore
    ui_root: Path
    central_advertiser: CentralServiceAdvertiser
    mobile_ca_path: Path | None
    mobile_ca_fingerprint: str
    mobile_https_ready = False
    mobile_failures: dict[str, list[float]] = {}
    mobile_failures_lock = threading.Lock()
    def log_message(self, fmt: str, *args: object) -> None:
        logging.info("%s - %s", self.address_string(), fmt % args)
    def send_json(self, status: int, payload: dict, origin: str | None = None) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.add_cors_headers(origin)
        self.end_headers()
        self.wfile.write(body)
    def add_cors_headers(self, origin: str | None) -> None:
        if origin and self.is_allowed_local_origin(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Vary", "Origin")
    @staticmethod
    def is_local_origin(origin: str) -> bool:
        return origin in {
            f"http://127.0.0.1:{PORT}",
            f"http://localhost:{PORT}",
        }

    def is_allowed_local_origin(self, origin: str) -> bool:
        if self.is_local_origin(origin):
            return True
        try:
            parsed_origin = urlsplit(origin)
            parsed_host = urlsplit(f"//{self.headers.get('Host', '')}")
            return (
                parsed_origin.scheme == "https"
                and parsed_origin.hostname is not None
                and parsed_origin.hostname == parsed_host.hostname
                and parsed_origin.port == MOBILE_PORT
                and parsed_host.port in (None, MOBILE_PORT)
                and parsed_origin.path in ("", "/")
                and not parsed_origin.username
                and not parsed_origin.password
                and not parsed_origin.query
                and not parsed_origin.fragment
                and self.is_secure_mobile_request()
            )
        except ValueError:
            return False
    def is_local_app_request(self) -> bool:
        origin = self.headers.get("Origin")
        return (
            self.is_local_loopback_request()
            and bool(origin)
            and self.is_allowed_local_origin(origin)
        )
    def is_local_app_read_request(self) -> bool:
        origin = self.headers.get("Origin")
        return (
            self.is_local_loopback_request()
            and (not origin or self.is_allowed_local_origin(origin))
        )
    def is_local_loopback_request(self) -> bool:
        return self.client_address[0] in ("127.0.0.1", "::1")
    def is_private_network_request(self) -> bool:
        try:
            ip = ipaddress.ip_address(self.client_address[0])
            if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
                ip = ip.ipv4_mapped
            return ip.is_private or ip.is_loopback
        except ValueError:
            return False
    def is_secure_mobile_request(self) -> bool:
        return isinstance(self.connection, ssl.SSLSocket)
    def serve_mobile_portal(self) -> None:
        try:
            host_header = self.headers.get("Host", "")
            parsed_host = urlsplit(f"//{host_header}")
            host = parsed_host.hostname
            port = parsed_host.port
        except ValueError:
            self.send_error(400, "O endereço local do celular é inválido.")
            return
        if (
            not host
            or parsed_host.username
            or parsed_host.password
            or port not in (None, PORT)
            or not re.fullmatch(r"[A-Za-z0-9.-]{1,253}", host)
            or host.startswith(".")
            or host.endswith(".")
            or ".." in host
        ):
            self.send_error(400, "O endereço local do celular é inválido.")
            return
        https_url = html_escape(f"https://{host}:{MOBILE_PORT}/", quote=True)
        ca_url = html_escape(f"http://{host}:{PORT}/api/mobile-ca", quote=True)
        fingerprint = html_escape(self.mobile_ca_fingerprint or "Não configurada")
        if self.mobile_https_ready:
            access_section = f"""
                <p class="status">Servidor seguro ativo na porta {MOBILE_PORT}.</p>
                <a class="button button-open" href="{https_url}">Abrir CRAS Desktop</a>
                <p class="hint">Depois de confiar no certificado, use o botão acima. No iPhone, abra no Safari.</p>
            """
        else:
            access_section = """
                <p class="status status-error">O acesso HTTPS pelo celular não está ativo neste computador.</p>
                <p class="hint">No CRAS Desktop, confira o status do acesso móvel nas Configurações.</p>
            """
        html = f"""<!doctype html>
<html lang="pt-BR">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#f1f6fa">
    <title>Conectar celular · CRAS Desktop</title>
    <style>
        :root {{
            color-scheme: light;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            color: #182b3a;
            background: #f1f6fa;
        }}
        * {{ box-sizing: border-box; }}
        body {{ margin: 0; padding: 20px 14px; line-height: 1.5; }}
        main {{ width: min(100%, 560px); margin: 0 auto; }}
        header {{ padding: 16px 4px 20px; text-align: center; }}
        header p, .hint {{ color: #526678; }}
        .card {{
            margin: 0 0 14px;
            padding: 18px;
            border: 1px solid #d7e1e9;
            border-radius: 16px;
            background: #fff;
            box-shadow: 0 8px 24px rgba(24, 43, 58, .07);
        }}
        h1 {{ margin: 0 0 6px; font-size: 1.55rem; }}
        h2 {{ margin: 0 0 10px; font-size: 1.1rem; }}
        p {{ margin: 8px 0; }}
        .button {{
            display: block;
            width: 100%;
            min-height: 48px;
            margin: 12px 0;
            padding: 12px 16px;
            border-radius: 10px;
            text-align: center;
            text-decoration: none;
            font-weight: 700;
        }}
        .button-download {{ border: 1px solid #9ccbe0; color: #075985; background: #e0f2fe; }}
        .button-open {{ color: #fff; background: #176b4d; }}
        .status {{ color: #166534; font-weight: 700; }}
        .status-error {{ color: #a3212d; }}
        .fingerprint {{
            overflow-wrap: anywhere;
            padding: 10px;
            border: 1px dashed #bdcbd5;
            border-radius: 8px;
            color: #334155;
            font-family: ui-monospace, monospace;
            font-size: .85rem;
        }}
        .tabs {{ display: flex; gap: 8px; margin: 12px 0; }}
        .tab-button {{
            flex: 1;
            min-height: 44px;
            border: 1px solid #cbd5e1;
            border-radius: 9px;
            background: #f8fafc;
            color: #334155;
            font: inherit;
        }}
        .tab-button[aria-selected="true"] {{ border-color: #176b4d; background: #e4f4ed; }}
        ol {{ padding-left: 22px; }}
        li {{ margin: 0 0 9px; }}
        [hidden] {{ display: none !important; }}
        @media (prefers-reduced-motion: reduce) {{ *, *::before, *::after {{ scroll-behavior: auto !important; }} }}
    </style>
</head>
<body>
    <main>
        <header>
            <p><strong>CRAS Desktop · Rede local</strong></p>
            <h1>Acessar pelo celular</h1>
            <p>Instale o certificado uma vez e abra o aplicativo seguro.</p>
        </header>
        <section class="card" aria-labelledby="certificate-title">
            <h2 id="certificate-title">1. Instalar o certificado de segurança</h2>
            <p>O certificado permite abrir o CRAS por uma conexão HTTPS confiável.</p>
            <a class="button button-download" href="{ca_url}">Baixar certificado CA</a>
            <p><strong>Impressão digital SHA-256:</strong></p>
            <p class="fingerprint">{fingerprint}</p>
            <div class="tabs" role="tablist" aria-label="Instruções para o celular">
                <button class="tab-button" id="android-tab" type="button" role="tab"
                    aria-controls="android-help" aria-selected="true">Android</button>
                <button class="tab-button" id="ios-tab" type="button" role="tab"
                    aria-controls="ios-help" aria-selected="false">iPhone (iOS)</button>
            </div>
            <div id="android-help" role="tabpanel" aria-labelledby="android-tab">
                <ol>
                    <li>Baixe o certificado pelo botão acima.</li>
                    <li>Abra as Configurações do Android e procure <strong>Instalar certificado</strong>.</li>
                    <li>Escolha <strong>Certificado CA</strong> e selecione o arquivo baixado.</li>
                </ol>
            </div>
            <div id="ios-help" role="tabpanel" aria-labelledby="ios-tab" hidden>
                <ol>
                    <li>Abra esta página no <strong>Safari</strong> e baixe o certificado acima.</li>
                    <li>Abra Ajustes, toque em <strong>Perfil Baixado</strong> e instale o perfil.</li>
                    <li>Em Ajustes → Geral → Sobre → <strong>Ajustes de Confiança do Certificado</strong>,
                        ative a confiança total para “CRAS Desktop Mobile CA”.</li>
                    <li>Volte ao Safari e abra o CRAS. Se solicitado, permita o acesso à rede local.</li>
                    <li>Para criar um atalho, use Compartilhar → <strong>Adicionar à Tela de Início</strong>.</li>
                </ol>
            </div>
        </section>
        <section class="card" aria-labelledby="access-title">
            <h2 id="access-title">2. Abrir o CRAS Desktop</h2>
            {access_section}
        </section>
    </main>
    <script>
        const tabs = [
            [document.getElementById("android-tab"), document.getElementById("android-help")],
            [document.getElementById("ios-tab"), document.getElementById("ios-help")]
        ];
        function selectMobileInstructions(index) {{
            tabs.forEach(([button, panel], tabIndex) => {{
                const active = tabIndex === index;
                button.setAttribute("aria-selected", String(active));
                panel.hidden = !active;
            }});
        }}
        tabs.forEach(([button], index) =>
            button.addEventListener("click", () => selectMobileInstructions(index)));
        const isAppleMobile = /iPhone|iPad|iPod/i.test(navigator.userAgent)
            || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
        if (isAppleMobile) selectMobileInstructions(1);
    </script>
</body>
</html>"""
        body = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)
    def mobile_attempt_allowed(self) -> bool:
        now = time.monotonic()
        address = self.client_address[0]
        with self.mobile_failures_lock:
            failures = [
                attempt for attempt in self.mobile_failures.get(address, [])
                if now - attempt < MOBILE_ACCESS_WINDOW_SECONDS
            ]
            self.mobile_failures[address] = failures
            return len(failures) < MOBILE_ACCESS_MAX_ATTEMPTS
    def record_mobile_attempt(self, failed: bool) -> None:
        address = self.client_address[0]
        with self.mobile_failures_lock:
            if failed:
                self.mobile_failures.setdefault(address, []).append(time.monotonic())
            else:
                self.mobile_failures.pop(address, None)
    def do_OPTIONS(self) -> None:
        origin = self.headers.get("Origin")
        if not origin or not self.is_allowed_local_origin(origin):
            self.send_error(403)
            return
        self.send_response(204)
        self.add_cors_headers(origin)
        self.send_header("Content-Length", "0")
        self.end_headers()
    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path == "/api/backup-status":
            if not self.is_local_app_read_request():
                self.send_error(403)
                return
            try:
                self.send_json(
                    200,
                    self.store.auto_backup_status(),
                    self.headers.get("Origin"),
                )
            except Exception:
                logging.exception("Não foi possível consultar o estado do backup automático.")
                self.send_json(
                    500,
                    {"error": "Não foi possível consultar o estado do backup automático."},
                    self.headers.get("Origin"),
                )
            return
        if path == "/api/machine-export-status":
            if not self.is_local_app_read_request():
                self.send_error(403)
                return
            try:
                self.send_json(
                    200,
                    self.store.machine_export_status(),
                    self.headers.get("Origin"),
                )
            except Exception:
                logging.exception("Não foi possível consultar o estado da exportação JSON.")
                self.send_json(
                    500,
                    {"error": "Não foi possível consultar o estado da exportação JSON."},
                    self.headers.get("Origin"),
                )
            return
        if path == "/api/server-transfer/export":
            if not self.is_local_app_read_request():
                self.send_error(403)
                return
            package_path = None
            response_started = False
            try:
                package_path = self.store.create_transfer_package()
                self.send_response(200)
                response_started = True
                self.add_cors_headers(self.headers.get("Origin"))
                self.send_header("Content-Type", "application/vnd.sqlite3")
                self.send_header(
                    "Content-Disposition",
                    f'attachment; filename="cras-server-transfer-{datetime.now():%Y-%m-%d}.sqlite3"',
                )
                self.send_header("Content-Length", str(package_path.stat().st_size))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                with package_path.open("rb") as source:
                    while chunk := source.read(1024 * 1024):
                        self.wfile.write(chunk)
            except Exception:
                logging.exception("Não foi possível exportar o pacote de transferência do servidor.")
                if not response_started:
                    self.send_json(
                        500,
                        {"error": "Não foi possível exportar o pacote do servidor."},
                        self.headers.get("Origin"),
                    )
            finally:
                if package_path:
                    try:
                        package_path.unlink()
                    except FileNotFoundError:
                        pass
            return
        if path == "/api/central-servers":
            if not self.is_local_app_read_request():
                self.send_error(403)
                return
            try:
                self.send_json(
                    200,
                    {"servers": discover_central_services()},
                    self.headers.get("Origin"),
                )
            except Exception as error:
                logging.exception("Não foi possível descobrir o servidor central na rede.")
                self.send_json(503, {"error": str(error)}, self.headers.get("Origin"))
            return
        if path == "/api/mobile-info":
            if not self.is_private_network_request() or (
                not self.is_local_loopback_request() and not self.is_secure_mobile_request()
            ):
                self.send_error(403)
                return
            info = self.store.mobile_access_info()
            info["ready"] = self.store.ready
            info["appVersion"] = app_version()
            self.send_json(200, info)
            return
        if path == "/api/mobile-snapshot":
            if not self.is_private_network_request() or not self.is_secure_mobile_request():
                self.send_error(403)
                return
            self.send_error(405)
            return
        if path == "/api/mobile-ca":
            if not self.is_private_network_request():
                self.send_error(403)
                return
            if self.mobile_ca_path is None:
                self.send_error(503, "O certificado HTTPS móvel não está disponível.")
                return
            try:
                body = self.mobile_ca_path.read_bytes()
            except OSError:
                logging.exception("Não foi possível ler o certificado da autoridade móvel.")
                self.send_error(500, "Não foi possível carregar o certificado móvel.")
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/x-x509-ca-cert")
            self.send_header("Content-Disposition", 'attachment; filename="cras-desktop-mobile-ca.crt"')
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/api/info":
            local_request = self.client_address[0] in ("127.0.0.1", "::1")
            query = parse_qs(urlsplit(self.path).query)
            addresses = lan_addresses()
            info = {
                "nodeId": self.store.node_id,
                "hostname": central_hostname(self.store.node_id),
                "appVersion": app_version(),
                "port": PORT,
                "addresses": addresses,
                "revision": self.store.get_revision(),
                "ready": self.store.ready,
                "mobilePort": MOBILE_PORT,
                "mobileCaFingerprint": self.mobile_ca_fingerprint,
                "mobileHttpsReady": self.mobile_https_ready,
                "centralServer": self.store.is_central_server(),
            }
            if local_request:
                if query.get("details") == ["1"]:
                    info["mobileAddresses"] = addresses
            self.send_json(200, info, self.headers.get("Origin"))
            return
        if path == "/api/chat/messages":
            if not self.is_local_app_read_request():
                self.send_error(403)
                return
            query = parse_qs(urlsplit(self.path).query)
            try:
                limit = int(query.get("limit", ["50"])[0])
                before = query.get("before", [""])[0]
                user_id = query.get("userId", [""])[0]
                recipient_id = query.get("recipientId", [""])[0] or None
                if not user_id:
                    raise ValueError("Selecione o usuário da conversa.")
                messages = self.store.list_chat_messages(limit, before, user_id, recipient_id)
                self.send_json(200, {"messages": messages}, self.headers.get("Origin"))
            except ValueError as error:
                self.send_json(400, {"error": str(error)}, self.headers.get("Origin"))
            except Exception:
                logging.exception("Não foi possível carregar as mensagens locais do chat.")
                self.send_json(500, {"error": "Não foi possível carregar o chat."},
                               self.headers.get("Origin"))
            return
        if path == "/api/chat/attachment":
            if not self.is_local_app_read_request():
                self.send_error(403)
                return
            query = parse_qs(urlsplit(self.path).query)
            try:
                user_id = query.get("userId", [""])[0]
                recipient_id = query.get("recipientId", [""])[0] or None
                if not user_id:
                    self.send_error(400)
                    return
                attachment = self.store.chat_attachment(
                    query.get("id", [""])[0],
                    user_id,
                    recipient_id,
                )
                if attachment is None:
                    self.send_error(404)
                    return
                content_type, body = attachment
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)
            except ValueError as error:
                self.send_json(400, {"error": str(error)}, self.headers.get("Origin"))
            except Exception:
                logging.exception("Não foi possível carregar uma imagem do chat.")
                self.send_json(500, {"error": "Não foi possível carregar a imagem do chat."},
                               self.headers.get("Origin"))
            return
        if path == "/api/local-snapshot":
            if not self.is_local_loopback_request():
                self.send_error(403)
                return
            self.send_json(200, self.store.get_local_state())
            return
        if path == "/api/check-update":
            if not self.is_local_loopback_request():
                self.send_error(403)
                return
            try:
                release = latest_release()
                current = app_version()
                if release:
                    self.send_json(200, {
                        "hasUpdate": True,
                        "latestVersion": release["version"],
                        "currentVersion": current,
                    }, self.headers.get("Origin"))
                else:
                    self.send_json(200, {
                        "hasUpdate": False,
                        "currentVersion": current,
                    }, self.headers.get("Origin"))
            except Exception as error:
                self.send_json(500, {"error": str(error)}, self.headers.get("Origin"))
            return
        if path == "/api/qr":
            query = parse_qs(urlsplit(self.path).query)
            text = query.get("text", [""])[0]
            if not text or len(text) > 512 or not HAVE_QRCODE:
                self.send_error(400)
                return
            try:
                img = qrcode.make(text, image_factory=qrcode.image.svg.SvgPathImage, box_size=8, border=2)
                body = img.to_string()
                self.send_response(200)
                self.send_header("Content-Type", "image/svg+xml")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "public, max-age=3600")
                self.end_headers()
                self.wfile.write(body)
            except Exception:
                self.send_error(500)
            return
        if not self.is_local_loopback_request() and not self.is_secure_mobile_request():
            accept = self.headers.get("Accept", "")
            if "text/html" in accept or "/" in accept or not accept:
                self.serve_mobile_portal()
                return
            self.send_json(426, {
                "error": "Na rede local, abra o endereço HTTPS do CRAS Desktop exibido nas Configurações."
            })
            return
        file_name = "CRAS.html" if path in ("/", "/CRAS.html") else path.lstrip("/")
        content_types = {
            "CRAS.html": "text/html; charset=utf-8",
            "CRAS.css": "text/css; charset=utf-8",
            "CRAS.js": "application/javascript; charset=utf-8",
            "dexie.min.js": "application/javascript; charset=utf-8",
            "manifest.webmanifest": "application/manifest+json; charset=utf-8",
            "sw.js": "application/javascript; charset=utf-8",
            "app-icon.svg": "image/svg+xml",
        }
        if file_name not in content_types:
            self.send_error(404)
            return
        file_path = self.ui_root / file_name
        try:
            body = file_path.read_bytes()
        except OSError:
            logging.exception("Não foi possível ler o recurso %s.", file_name)
            self.send_error(500, "Não foi possível carregar a interface.")
            return
        self.send_response(200)
        self.send_header("Content-Type", content_types[file_name])
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache" if file_name == "sw.js" else "no-store")
        if file_name == "sw.js":
            self.send_header("Service-Worker-Allowed", "/")
        self.end_headers()
        self.wfile.write(body)
    def do_POST(self) -> None:
        path = urlsplit(self.path).path
        if path == "/api/server-transfer/import":
            if not self.is_local_app_request():
                self.send_error(403)
                return
            temporary_path = self.store.path.parent / f".cras-transfer-upload-{uuid.uuid4().hex}.sqlite3"
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0 or length > MAX_SERVER_TRANSFER_BYTES:
                    raise ValueError("O pacote de transferência está vazio ou excede o limite de 256 MB.")
                remaining = length
                with temporary_path.open("wb") as destination:
                    while remaining:
                        chunk = self.rfile.read(min(1024 * 1024, remaining))
                        if not chunk:
                            raise ValueError("O envio do pacote foi interrompido.")
                        destination.write(chunk)
                        remaining -= len(chunk)
                revision = self.store.restore_transfer_package(temporary_path)
                try:
                    self.central_advertiser.set_enabled(True)
                except Exception:
                    self.store.set_central_server(False)
                    raise
                self.send_json(
                    200,
                    {"success": True, "revision": revision, "nodeId": self.store.node_id},
                    self.headers.get("Origin"),
                )
            except (ValueError, json.JSONDecodeError) as error:
                self.send_json(400, {"error": str(error)}, self.headers.get("Origin"))
            except Exception as error:
                logging.exception("Não foi possível restaurar o pacote de transferência do servidor.")
                self.send_json(
                    500,
                    {"error": f"Não foi possível restaurar o servidor: {error}"},
                    self.headers.get("Origin"),
                )
            finally:
                try:
                    temporary_path.unlink()
                except FileNotFoundError:
                    pass
            return
        if path == "/api/central-config":
            if not self.is_local_app_request():
                self.send_error(403)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0 or length > 1024:
                    raise ValueError("Tamanho de configuração inválido.")
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                if not isinstance(payload, dict) or not isinstance(payload.get("enabled"), bool):
                    raise ValueError("A configuração do servidor central é inválida.")
                self.central_advertiser.set_enabled(payload["enabled"])
                self.store.set_central_server(payload["enabled"])
                self.send_json(
                    200,
                    {"enabled": payload["enabled"]},
                    self.headers.get("Origin"),
                )
            except (ValueError, json.JSONDecodeError) as error:
                self.send_json(400, {"error": str(error)}, self.headers.get("Origin"))
            except Exception as error:
                logging.exception("Não foi possível atualizar o papel de servidor central.")
                self.send_json(503, {"error": str(error)}, self.headers.get("Origin"))
            return
        if path == "/api/user/register":
            if not self.is_private_network_request():
                self.send_error(403)
                return
            origin = self.headers.get("Origin")
            if origin and not self.is_allowed_local_origin(origin):
                self.send_error(403)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0 or length > 4096:
                    raise ValueError("Tamanho de credencial inválido.")
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                if not isinstance(payload, dict):
                    raise ValueError("A credencial individual está inválida.")
                self.store.register_user_credential(
                    payload.get("userId"),
                    payload.get("credential"),
                    payload.get("name"),
                    payload.get("role"),
                )
                self.send_json(200, {"registered": True}, origin)
            except (ValueError, json.JSONDecodeError) as error:
                self.send_json(409, {"error": str(error)}, origin)
            except Exception:
                logging.exception("Não foi possível cadastrar a credencial individual no servidor.")
                self.send_json(500, {"error": "Não foi possível cadastrar a senha no servidor."}, origin)
            return
        if path in ("/api/user/auth-challenge", "/api/user/authenticate"):
            if not self.is_private_network_request():
                self.send_error(403)
                return
            origin = self.headers.get("Origin")
            if origin and not self.is_allowed_local_origin(origin):
                self.send_error(403)
                return
            address = self.client_address[0]
            if not self.store.user_auth_attempt_allowed(address):
                self.send_json(
                    429,
                    {"error": "Muitas tentativas de autenticação. Aguarde cinco minutos e tente novamente."},
                    origin,
                )
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0 or length > 4096:
                    raise ValueError("Tamanho de pedido de autenticação inválido.")
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                if not isinstance(payload, dict):
                    raise ValueError("O pedido de autenticação está inválido.")
                user_id = payload.get("userId")
                if path == "/api/user/auth-challenge":
                    challenge = self.store.create_user_auth_challenge(user_id)
                    if not challenge:
                        self.send_json(
                            404,
                            {"error": "Não há senha desse usuário cadastrada no servidor central."},
                            origin,
                        )
                        return
                    self.send_json(200, challenge, origin)
                    return
                authenticated = self.store.verify_user_auth_challenge(
                    user_id,
                    payload.get("challengeId"),
                    payload.get("proof"),
                )
                self.store.record_user_auth_attempt(address, not authenticated)
                if not authenticated:
                    self.send_json(
                        401,
                        {"error": "Senha do servidor incorreta ou desafio expirado."},
                        origin,
                    )
                    return
                self.send_json(200, {"authenticated": True}, origin)
            except (ValueError, json.JSONDecodeError) as error:
                self.send_json(400, {"error": str(error)}, origin)
            except Exception:
                logging.exception("Não foi possível autenticar a senha já cadastrada no servidor.")
                self.send_json(500, {"error": "Não foi possível validar a senha no servidor."}, origin)
            return
        if path == "/api/chat/messages":
            if not self.is_local_app_request():
                self.send_error(403)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0 or length > MAX_CHAT_MESSAGE_BYTES + 16 * 1024:
                    raise ValueError("Tamanho da mensagem do chat inválido.")
                message = json.loads(self.rfile.read(length).decode("utf-8"))
                stored = self.store.store_chat_message(message)
                self.send_json(200, {"message": stored}, self.headers.get("Origin"))
            except (ValueError, json.JSONDecodeError) as error:
                self.send_json(400, {"error": str(error)}, self.headers.get("Origin"))
            except Exception:
                logging.exception("Não foi possível salvar uma mensagem local do chat.")
                self.send_json(500, {"error": "Não foi possível salvar a mensagem do chat."},
                               self.headers.get("Origin"))
            return
        if path == "/api/chat/sync":
            origin = self.headers.get("Origin")
            if not self.is_private_network_request():
                self.send_error(403)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0 or length > MAX_BODY_BYTES:
                    raise ValueError("Tamanho da mensagem sincronizada inválido.")
                envelope = json.loads(self.rfile.read(length).decode("utf-8"))
                user_id = envelope.get("userId") if isinstance(envelope, dict) else None
                credential = self.store.get_user_credential(user_id)
                profile = self.store.get_user_profile(user_id)
                if not credential or not profile:
                    self.send_json(401, {"error": "Cadastre sua senha individual neste servidor primeiro."}, origin)
                    return
                salt, payload = decode_envelope(envelope, credential)
                if payload.get("userId") != user_id:
                    raise ValueError("A identidade do usuário não corresponde à solicitação.")
                operation = payload.get("operation", "send")
                if operation == "list":
                    result = {
                        "messages": self.store.list_chat_messages(
                            payload.get("limit", 50),
                            payload.get("before", ""),
                            user_id,
                            payload.get("recipientId"),
                        )
                    }
                elif operation == "attachment":
                    attachment = self.store.chat_attachment(
                        payload.get("messageId"),
                        user_id,
                        payload.get("recipientId"),
                    )
                    if attachment is None:
                        raise ValueError("A imagem da mensagem não foi encontrada no servidor.")
                    content_type, body = attachment
                    result = {
                        "attachment": {
                            "type": content_type,
                            "data": base64.b64encode(body).decode("ascii"),
                        }
                    }
                else:
                    message = validate_chat_message(payload.get("message"))
                    if (
                        message["authorId"] != user_id
                        or message["authorName"] != profile["name"]
                        or message["authorRole"] != profile["role"]
                    ):
                        raise ValueError("Só é possível enviar mensagens em nome do usuário autenticado.")
                    message = self.store.store_chat_message(message)
                    result = {"messageId": message["id"]}
                self.send_json(
                    200,
                    encode_envelope(salt, credential, result),
                    origin,
                )
            except InvalidTag:
                self.send_json(401, {"error": "Senha individual inválida ou mensagem adulterada."}, origin)
            except (ValueError, json.JSONDecodeError) as error:
                self.send_json(400, {"error": str(error)}, origin)
            except Exception:
                logging.exception("Não foi possível processar uma operação do chat central.")
                self.send_json(500, {"error": "Não foi possível sincronizar a mensagem do chat."}, origin)
            return
        if path == "/api/apply-update":
            if not self.is_local_app_request():
                self.send_error(403)
                return
            if not getattr(sys, "frozen", False) or os.name != "nt":
                self.send_json(400, {"error": "Atualizações automáticas só podem ser aplicadas no aplicativo compilado (.exe)."}, self.headers.get("Origin"))
                return
            try:
                release = latest_release()
                if not release:
                    self.send_json(404, {"error": "Nenhuma atualização disponível no momento."}, self.headers.get("Origin"))
                    return
                directory = data_path()
                update_path = download_update(release, directory)
                launch_update_helper(update_path, Path(sys.executable), os.getpid(), directory)
                self.send_json(200, {"success": True, "message": "Atualização baixada. O aplicativo será reiniciado em instantes..."}, self.headers.get("Origin"))
                threading.Timer(1.5, lambda: os._exit(0)).start()
            except Exception as error:
                logging.exception("Falha ao aplicar atualização solicitada pela interface.")
                self.send_json(500, {"error": str(error)}, self.headers.get("Origin"))
            return
        if path == "/api/mobile-config":
            if not self.is_local_app_request():
                self.send_error(403)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0 or length > 1024:
                    raise ValueError("Tamanho de pedido inválido.")
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                if not isinstance(payload, dict) or not isinstance(payload.get("mobilePin"), str):
                    raise ValueError("O código móvel está inválido.")
                self.store.configure_mobile_access(payload["mobilePin"])
                self.send_json(200, {"enabled": bool(payload["mobilePin"])})
            except (ValueError, json.JSONDecodeError) as error:
                self.send_json(400, {"error": str(error)})
            except Exception:
                logging.exception("Não foi possível configurar o acesso móvel.")
                self.send_json(500, {"error": "Não foi possível salvar o acesso móvel."})
            return
        if path == "/api/mobile-snapshot":
            if not self.is_private_network_request() or not self.is_secure_mobile_request():
                self.send_error(403)
                return
            if not self.mobile_attempt_allowed():
                self.send_json(429, {"error": "Muitas tentativas de acesso. Aguarde cinco minutos."})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0 or length > MAX_BODY_BYTES:
                    raise ValueError("Tamanho de pedido inválido ou acima do limite.")
                envelope = json.loads(self.rfile.read(length).decode("utf-8"))
                key = self.store.mobile_access_key()
                if key is None:
                    self.send_json(403, {"error": "O acesso móvel ainda não foi configurado no computador."})
                    return
                try:
                    payload = decode_mobile_payload(envelope, key)
                except InvalidTag:
                    self.record_mobile_attempt(True)
                    self.send_json(401, {"error": "Código de acesso móvel incorreto."})
                    return
                self.record_mobile_attempt(False)
                operation = payload.get("operation")
                if operation == "read":
                    state = self.store.get_local_state()
                    if not state["ready"]:
                        self.send_json(503, {"error": "O computador ainda está inicializando. Tente novamente."})
                        return
                    result = {
                        "snapshot": state["snapshot"],
                        "revision": state["revision"],
                        "actorRole": state["actorRole"],
                        "appVersion": app_version(),
                    }
                    self.send_json(200, encode_mobile_payload(key, result))
                    return
                if operation != "write":
                    raise ValueError("Operação móvel inválida.")
                require_compatible_sync_version(payload.get("clientVersion"))
                revision = self.store.save_local_snapshot(
                    payload.get("snapshot"),
                    payload.get("expectedRevision"),
                    payload.get("actorRole"),
                )
                self.send_json(200, encode_mobile_payload(key, {"revision": revision}))
            except RevisionConflict as error:
                self.send_json(409, {"error": str(error), "revision": error.revision})
            except (ValueError, json.JSONDecodeError) as error:
                self.send_json(400, {"error": str(error)})
            except Exception:
                logging.exception("Falha ao processar o estado móvel do CRAS Desktop.")
                self.send_json(500, {"error": "Não foi possível salvar ou carregar os dados móveis."})
            return
        if path == "/api/backup-config":
            if not self.is_local_app_request():
                self.send_error(403)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0 or length > 1024:
                    raise ValueError("Configuração de backup inválida.")
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                if not isinstance(payload, dict) or not isinstance(payload.get("isPrincipal"), bool):
                    raise ValueError("Informe se este computador é o PC Principal.")
                self.store.set_principal(payload["isPrincipal"])
                backup_path = self.store.create_auto_backup() if payload["isPrincipal"] else None
                self.send_json(
                    200,
                    {
                        "enabled": payload["isPrincipal"],
                        "backup": backup_path.name if backup_path else "",
                    },
                    self.headers.get("Origin"),
                )
            except (ValueError, json.JSONDecodeError) as error:
                self.send_json(400, {"error": str(error)}, self.headers.get("Origin"))
            except Exception:
                logging.exception("Não foi possível configurar o backup automático.")
                self.send_json(500, {"error": "Não foi possível configurar ou criar o backup automático."},
                               self.headers.get("Origin"))
            return
        if path in ("/api/local-snapshot", "/api/accept-sync"):
            if not self.is_local_app_request():
                self.send_error(403)
                return
            origin = self.headers.get("Origin")
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0 or length > MAX_BODY_BYTES:
                    raise ValueError("Tamanho de pedido inválido ou acima do limite.")
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                if not isinstance(payload, dict):
                    raise ValueError("Pacote local inválido.")
                if path == "/api/local-snapshot":
                    revision = self.store.save_local_snapshot(
                        payload.get("snapshot"),
                        payload.get("expectedRevision"),
                        payload.get("actorRole"),
                    )
                else:
                    revision = self.store.accept_synced_snapshot(
                        payload.get("peerId"),
                        payload.get("snapshot"),
                        payload.get("peerBase"),
                        payload.get("expectedRevision"),
                        payload.get("actorRole"),
                    )
                self.send_json(200, {"revision": revision}, origin)
            except RevisionConflict as error:
                self.send_json(409, {"error": str(error), "revision": error.revision}, origin)
            except (ValueError, json.JSONDecodeError) as error:
                self.send_json(400, {"error": str(error)}, origin)
            except Exception:
                logging.exception("Falha ao persistir o estado local.")
                self.send_json(500, {"error": "Não foi possível salvar o estado local de sincronização."}, origin)
            return
        if path != "/api/sync":
            self.send_error(404)
            return
        if not self.is_private_network_request():
            self.send_error(403)
            return
        origin = self.headers.get("Origin")
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_json(400, {"error": "Tamanho de pedido inválido."}, origin)
            return
        if length <= 0 or length > MAX_BODY_BYTES:
            self.send_json(413, {"error": "Tamanho de pedido inválido ou acima do limite."}, origin)
            return
        try:
            envelope = json.loads(self.rfile.read(length).decode("utf-8"))
            user_id = envelope.get("userId") if isinstance(envelope, dict) else None
            credential = self.store.get_user_credential(user_id)
            profile = self.store.get_user_profile(user_id)
            if not credential or not profile:
                self.send_json(401, {"error": "Cadastre sua senha individual neste servidor primeiro."}, origin)
                return
            salt, payload = decode_envelope(envelope, credential)
            if payload.get("userId") != user_id:
                raise ValueError("A identidade do usuário não corresponde à solicitação.")
            require_compatible_sync_version(payload.get("clientVersion"))
            result = self.store.sync(
                payload.get("peerId"),
                payload.get("requestId"),
                payload.get("localSnapshot"),
                payload.get("resolutions"),
                profile["role"],
            )
            self.send_json(200, encode_envelope(salt, credential, result), origin)
        except Exception as error:
            logging.exception("Falha ao processar sincronização de um par.")
            message = "Não foi possível validar ou processar a sincronização."
            if isinstance(error, InvalidTag):
                message = "Senha individual inválida ou pacote de sincronização adulterado."
            if isinstance(error, ValueError):
                message = str(error)
            self.send_json(401 if isinstance(error, InvalidTag) else 400, {"error": message}, origin)
def configure_logging(directory: Path) -> None:
    logging.basicConfig(
        filename=directory / "app.log",
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        encoding="utf-8",
    )


def automatic_backup_scheduler(store: PeerStore) -> None:
    while True:
        try:
            store.archive_old_chat_messages()
            if store.is_principal() and store.ready:
                store.create_auto_backup()
        except Exception:
            logging.exception("Falha ao criar o backup diário automático.")
        time.sleep(300)


def show_startup_error(message: str) -> None:
    try:
        import tkinter
        from tkinter import messagebox
        root = tkinter.Tk()
        root.withdraw()
        messagebox.showerror(APP_NAME, message)
        root.destroy()
    except Exception:
        logging.exception("Não foi possível exibir o erro de inicialização.")
def main() -> None:
    try:
        user_data = data_path()
        configure_logging(user_data)
        store = PeerStore(user_data / "cras-desktop.sqlite3")
    except Exception as error:
        logging.exception("Não foi possível inicializar o armazenamento do CRAS Desktop.")
        show_startup_error(f"Não foi possível inicializar o armazenamento local do aplicativo.\n\nDetalhe: {error}")
        return
    threading.Thread(
        target=automatic_backup_scheduler,
        args=(store,),
        name="cras-auto-backup",
        daemon=True,
    ).start()
    if check_for_update():
        return
    mobile_ca_path = None
    mobile_cert_path = None
    mobile_key_path = None
    mobile_ca_fingerprint = ""
    try:
        mobile_ca_path, mobile_cert_path, mobile_key_path, mobile_ca_fingerprint = (
            ensure_mobile_tls_certificates(
                user_data / "mobile-tls",
                lan_addresses(),
                central_hostname(store.node_id),
            )
        )
    except Exception as error:
        logging.exception("Não foi possível preparar o acesso HTTPS móvel.")
        show_startup_error(
            "Não foi possível preparar o certificado HTTPS para o celular. "
            "O aplicativo continuará disponível neste computador.\n\n"
            f"Detalhe: {error}"
        )
    CRASRequestHandler.store = store
    central_advertiser = CentralServiceAdvertiser(store.node_id)
    CRASRequestHandler.central_advertiser = central_advertiser
    CRASRequestHandler.ui_root = resource_path(".")
    CRASRequestHandler.mobile_ca_path = mobile_ca_path
    CRASRequestHandler.mobile_ca_fingerprint = mobile_ca_fingerprint
    try:
        if store.is_central_server():
            try:
                central_advertiser.set_enabled(True)
            except Exception as error:
                store.set_central_server(False)
                show_startup_error(
                    "A descoberta do servidor central não pôde ser iniciada. "
                    "O aplicativo continuará localmente; ative novamente o servidor nas Configurações.\n\n"
                    f"Detalhe: {error}"
                )
        server = ThreadingHTTPServer(("0.0.0.0", PORT), CRASRequestHandler)
    except OSError as error:
        logging.exception("Não foi possível iniciar o servidor da rede local.")
        show_startup_error(
            f"Não foi possível abrir a porta {PORT} para a rede local.\n"
            "Feche outra instância do CRAS Desktop ou libere a porta e tente novamente.\n\n"
            f"Detalhe: {error}"
        )
        return
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, name="cras-http", daemon=True).start()
    logging.info("Aplicativo iniciado no endereço local e na porta %s.", PORT)
    mobile_server = None
    if mobile_cert_path and mobile_key_path:
        try:
            mobile_server = ThreadingHTTPServer(("0.0.0.0", MOBILE_PORT), CRASRequestHandler)
            mobile_server.socket = mobile_tls_context(mobile_cert_path, mobile_key_path).wrap_socket(
                mobile_server.socket,
                server_side=True,
            )
            mobile_server.daemon_threads = True
            threading.Thread(
                target=mobile_server.serve_forever,
                name="cras-https-mobile",
                daemon=True,
            ).start()
            CRASRequestHandler.mobile_https_ready = True
            logging.info("Acesso HTTPS móvel iniciado na porta %s.", MOBILE_PORT)
        except OSError as error:
            logging.exception("Não foi possível iniciar o servidor HTTPS móvel.")
            if mobile_server:
                mobile_server.server_close()
            mobile_server = None
            CRASRequestHandler.mobile_https_ready = False
            show_startup_error(
                f"Não foi possível abrir a porta segura {MOBILE_PORT} para o celular.\n"
                "O aplicativo continuará disponível neste computador; libere a porta e reinicie para usar o celular.\n\n"
                f"Detalhe: {error}"
            )
        except Exception as error:
            logging.exception("Não foi possível iniciar o servidor HTTPS móvel.")
            if mobile_server:
                mobile_server.server_close()
            mobile_server = None
            CRASRequestHandler.mobile_https_ready = False
            show_startup_error(
                "Não foi possível iniciar o acesso HTTPS móvel. O aplicativo continuará disponível neste computador.\n\n"
                f"Detalhe: {error}"
            )
    try:
        webview.create_window(
            "Atendimento | CRAS Ouro Preto",
            f"http://127.0.0.1:{PORT}/",
            width=1360,
            height=900,
            min_size=(960, 640),
        )
        webview.start(debug=False, private_mode=False, storage_path=str(user_data / "webview"))
    except Exception as error:
        logging.exception("Falha ao iniciar a janela desktop.")
        show_startup_error(
            "Não foi possível abrir a janela do aplicativo.\n"
            "Confirme se o Microsoft Edge WebView2 Runtime está instalado.\n\n"
            f"Detalhe: {error}"
        )
    finally:
        server.shutdown()
        server.server_close()
        if mobile_server:
            mobile_server.shutdown()
            mobile_server.server_close()
        central_advertiser.close()
if __name__ == "__main__":
    main()
