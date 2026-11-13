from __future__ import annotations

import base64
import binascii
from contextlib import closing
import ctypes
import hashlib
import gzip
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
MAX_BODY_BYTES = 12 * 1024 * 1024
MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024
MAX_PEERS = 100
MAX_MANUAL_ADDRESSES = 32
AUTO_BACKUP_RETENTION = 30
MAX_CHAT_TEXT_LENGTH = 4000
MAX_CHAT_ATTACHMENT_BYTES = 2 * 1024 * 1024
MAX_CHAT_MESSAGE_BYTES = 3 * 1024 * 1024
CHAT_ATTACHMENT_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}

PBKDF2_ITERATIONS = 200_000
MOBILE_ACCESS_ITERATIONS = 600_000

EMPTY_SNAPSHOT = {"appointments": [], "paaRecords": [], "settings": {}}
VALID_USER_ROLES = {"assistant", "caseworker", "reception", "intern", "admin"}
MOBILE_ACCESS_MIN_LENGTH = 12
MOBILE_ACCESS_MAX_ATTEMPTS = 5
MOBILE_ACCESS_WINDOW_SECONDS = 300
MISSING = object()


def update_ssl_context() -> ssl.SSLContext:
    return truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)


class RevisionConflict(Exception):
    def __init__(self, revision: int):
        super().__init__("O estado P2P mudou durante a gravação.")
        self.revision = revision


def resource_path(name: str) -> Path:
    root = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
    return root / name


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
def validate_snapshot(snapshot: object) -> dict:
    if not isinstance(snapshot, dict):
        raise ValueError("O pacote de sincronização está inválido.")
    if not isinstance(snapshot.get("appointments"), list) or not isinstance(snapshot.get("paaRecords"), list):
        raise ValueError("As coleções de atendimentos ou PAA estão inválidas.")
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
            seen.add(item["id"])
    return snapshot


def validate_peer_directory(peers: object) -> list[dict[str, str]]:
    if not isinstance(peers, list) or len(peers) > MAX_PEERS:
        raise ValueError("A lista de computadores vinculados é inválida.")
    validated = []
    seen = set()
    for peer in peers:
        if not isinstance(peer, dict):
            raise ValueError("Há um computador inválido na lista de parceiros.")
        endpoint = peer.get("endpoint")
        token = peer.get("token")
        node_id = peer.get("nodeId", "")
        if not isinstance(endpoint, str) or not isinstance(token, str):
            raise ValueError("O endereço e o código de um parceiro são inválidos.")
        if not endpoint or len(endpoint) > 512 or not token or len(token) > 512:
            raise ValueError("O endereço ou código de um parceiro excede o tamanho permitido.")
        if any(ord(character) < 32 for character in endpoint + token):
            raise ValueError("O endereço ou código de um parceiro contém caracteres inválidos.")
        parsed = urlsplit(endpoint)
        try:
            port = parsed.port if parsed.port is not None else PORT
        except ValueError as error:
            raise ValueError("A porta de um computador parceiro é inválida.") from error
        host = parsed.hostname
        try:
            address = ipaddress.IPv4Address(host or "")
        except ipaddress.AddressValueError as error:
            raise ValueError("Os computadores vinculados precisam usar um endereço IPv4 local.") from error
        if (
            parsed.scheme != "http"
            or port != PORT
            or parsed.username
            or parsed.password
            or parsed.path not in ("", "/")
            or parsed.query
            or parsed.fragment
            or not address.is_private
            or address.is_loopback
            or address.is_link_local
            or address.is_unspecified
            or address.is_multicast
        ):
            raise ValueError("O endereço de um computador parceiro não é válido para a rede local.")
        if not isinstance(node_id, str) or len(node_id) > 100:
            raise ValueError("A identificação de um computador parceiro é inválida.")
        normalized_host = str(address)
        normalized_endpoint = f"http://{normalized_host}:{PORT}"
        dedupe_key = normalized_endpoint, token
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        entry = {"endpoint": normalized_endpoint, "token": token}
        if node_id:
            entry["nodeId"] = node_id
        validated.append(entry)
    return validated


def validate_manual_addresses(addresses: object) -> list[str]:
    if not isinstance(addresses, list) or len(addresses) > MAX_MANUAL_ADDRESSES:
        raise ValueError("A lista de endereços manuais é inválida.")
    validated = []
    seen = set()
    for value in addresses:
        if not isinstance(value, str):
            raise ValueError("Informe endereços IPv4 privados válidos.")
        try:
            address = ipaddress.IPv4Address(value.strip())
        except ipaddress.AddressValueError as error:
            raise ValueError("Informe endereços IPv4 privados válidos.") from error
        if (
            not address.is_private
            or address.is_loopback
            or address.is_link_local
            or address.is_unspecified
            or address.is_multicast
            or address.is_reserved
        ):
            raise ValueError("Use somente endereços IPv4 privados atribuídos a este computador.")
        normalized = str(address)
        if normalized not in seen:
            seen.add(normalized)
            validated.append(normalized)
    return validated


def validate_chat_message(message: object) -> dict:
    if not isinstance(message, dict):
        raise ValueError("A mensagem do chat está inválida.")
    message_id = message.get("id")
    created_at = message.get("createdAt")
    author_id = message.get("authorId")
    author_name = message.get("authorName")
    author_role = message.get("authorRole")
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
                    "(id TEXT PRIMARY KEY, created_at TEXT NOT NULL, month TEXT NOT NULL, payload TEXT NOT NULL)"
                )
                db.execute(
                    "INSERT OR IGNORE INTO current_snapshot (id, payload) VALUES (1, ?)",
                    (canonical(EMPTY_SNAPSHOT),),
                )
                self.node_id = self.get_or_create(db, "node_id", str(uuid.uuid4()))
                self.pairing_key = self.get_or_create(db, "pairing_key", secrets.token_urlsafe(24))
                self.active_role = self.get_or_create(db, "active_role", "")
                self.get_or_create(db, "peer_directory", "[]")
                self.get_or_create(db, "manual_addresses", "[]")
                self.get_or_create(db, "is_principal", "false")
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
    def get_peer_directory(self) -> list[dict[str, str]]:
        with self.lock, closing(self.connect()) as db:
            row = db.execute(
                "SELECT value FROM metadata WHERE key = 'peer_directory'"
            ).fetchone()
            return validate_peer_directory(json.loads(row[0]) if row else [])
    def set_peer_directory(self, peers: object) -> int:
        validated = validate_peer_directory(peers)
        with self.lock, closing(self.connect()) as db:
            with db:
                db.execute(
                    "UPDATE metadata SET value = ? WHERE key = 'peer_directory'",
                    (canonical(validated),),
                )
        return len(validated)
    def get_manual_addresses(self) -> list[str]:
        with self.lock, closing(self.connect()) as db:
            row = db.execute(
                "SELECT value FROM metadata WHERE key = 'manual_addresses'"
            ).fetchone()
            return validate_manual_addresses(json.loads(row[0]) if row else [])
    def set_manual_addresses(self, addresses: object) -> list[str]:
        validated = validate_manual_addresses(addresses)
        with self.lock, closing(self.connect()) as db:
            with db:
                db.execute(
                    "INSERT INTO metadata (key, value) VALUES ('manual_addresses', ?) "
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    (canonical(validated),),
                )
        return validated
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
                    "INSERT INTO chat_messages (id, created_at, month, payload) VALUES (?, ?, ?, ?)",
                    (validated["id"], validated["createdAt"], message_month, payload),
                )
        return validated
    def list_chat_messages(self, limit: int = 50, before: str = "") -> list[dict]:
        if not isinstance(limit, int) or not 1 <= limit <= 100:
            raise ValueError("A quantidade de mensagens solicitada é inválida.")
        if before:
            try:
                before = datetime.fromisoformat(before.replace("Z", "+00:00")).astimezone(
                    timezone.utc
                ).isoformat()
            except ValueError as error:
                raise ValueError("A data para carregar mensagens anteriores é inválida.") from error
        query = "SELECT payload FROM chat_messages"
        parameters: tuple = ()
        if before:
            query += " WHERE created_at < ?"
            parameters = (before,)
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
    def chat_attachment(self, message_id: str) -> tuple[str, bytes] | None:
        if not isinstance(message_id, str) or not message_id or len(message_id) > 100:
            raise ValueError("A identificação da imagem é inválida.")
        with self.lock, closing(self.connect()) as db:
            row = db.execute(
                "SELECT payload FROM chat_messages WHERE id = ?", (message_id,)
            ).fetchone()
        if not row:
            return None
        message = json.loads(row[0])
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
        valid_snapshot = validate_snapshot(snapshot)
        if actor_role is not None and (
            not isinstance(actor_role, str) or actor_role not in VALID_USER_ROLES
        ):
            raise ValueError("O perfil do usuário local é inválido.")
        with self.lock, closing(self.connect()) as db:
            with db:
                row = db.execute("SELECT revision FROM current_snapshot WHERE id = 1").fetchone()
                current_revision = int(row[0]) if row else 0
                if expected_revision != current_revision:
                    raise RevisionConflict(current_revision)
                db.execute(
                    "UPDATE current_snapshot SET payload = ?, revision = revision + 1 WHERE id = 1",
                    (canonical(valid_snapshot),),
                )
                if actor_role is not None:
                    db.execute(
                        "UPDATE metadata SET value = ? WHERE key = 'active_role'",
                        (actor_role,),
                    )
                    self.active_role = actor_role
                row = db.execute("SELECT revision FROM current_snapshot WHERE id = 1").fetchone()
                self.ready = True
                return int(row[0])
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
        valid_snapshot = validate_snapshot(snapshot)
        valid_peer_base = validate_snapshot(peer_base)
        if actor_role is not None and (
            not isinstance(actor_role, str) or actor_role not in VALID_USER_ROLES
        ):
            raise ValueError("O perfil do usuário local é inválido.")
        payload = canonical(valid_snapshot)
        with self.lock, closing(self.connect()) as db:
            with db:
                row = db.execute("SELECT revision FROM current_snapshot WHERE id = 1").fetchone()
                current_revision = int(row[0]) if row else 0
                if expected_revision != current_revision:
                    raise RevisionConflict(current_revision)
                db.execute(
                    "UPDATE current_snapshot SET payload = ?, revision = revision + 1 WHERE id = 1",
                    (payload,),
                )
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
                return int(row[0])
    def sync(
        self,
        peer_id: str,
        request_id: str,
        local_snapshot: object,
        resolutions: object,
        peer_role: object = None,
        known_peers: object = None,
    ) -> dict:
        if not self.ready:
            raise ValueError("O outro computador ainda está inicializando. Tente sincronizar novamente em instantes.")
        if not isinstance(peer_id, str) or not peer_id.strip() or len(peer_id) > 100:
            raise ValueError("Identificação do computador remoto inválida.")
        if not isinstance(request_id, str) or not request_id.strip() or len(request_id) > 100:
            raise ValueError("Identificação da solicitação inválida.")
        local = validate_snapshot(local_snapshot)
        incoming_peers = validate_peer_directory([] if known_peers is None else known_peers)
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
                base_row = db.execute("SELECT payload FROM peer_bases WHERE peer_id = ?", (peer_id,)).fetchone()
                base = validate_snapshot(json.loads(base_row[0])) if base_row else dict(EMPTY_SNAPSHOT)
                merged = {
                    "appointments": self.merge_collection(
                        "appointments", base, local, remote, peer_role, self.active_role
                    ),
                    "paaRecords": self.merge_collection(
                        "paaRecords", base, local, remote, peer_role, self.active_role
                    ),
                    "settings": self.merge_settings(
                        base, local, remote, peer_role, self.active_role
                    ),
                }
                directory_row = db.execute(
                    "SELECT value FROM metadata WHERE key = 'peer_directory'"
                ).fetchone()
                peer_directory = validate_peer_directory(
                    json.loads(directory_row[0]) if directory_row else []
                )
                directory_keys = {
                    (peer["endpoint"], peer["token"]) for peer in peer_directory
                }
                for peer in incoming_peers:
                    key = (peer["endpoint"], peer["token"])
                    if key not in directory_keys:
                        directory_keys.add(key)
                        peer_directory.append(peer)
                if len(peer_directory) > MAX_PEERS:
                    raise ValueError("A rede vinculada excedeu o limite de computadores permitido.")
                validate_snapshot(merged)
                payload = canonical(merged)
                db.execute(
                    "UPDATE current_snapshot SET payload = ?, revision = revision + 1 WHERE id = 1",
                    (payload,),
                )
                db.execute(
                    "INSERT INTO peer_bases (peer_id, payload) VALUES (?, ?) "
                    "ON CONFLICT(peer_id) DO UPDATE SET payload = excluded.payload",
                    (peer_id, payload),
                )
                db.execute(
                    "INSERT INTO seen_requests (peer_id, request_id) VALUES (?, ?)",
                    (peer_id, request_id),
                )
                db.execute(
                    "INSERT INTO metadata (key, value) VALUES ('peer_directory', ?) "
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    (canonical(peer_directory),),
                )
                revision = db.execute("SELECT revision FROM current_snapshot WHERE id = 1").fetchone()[0]
                return {
                    "status": "ok",
                    "snapshot": merged,
                    "revision": revision,
                    "syncedAt": datetime.now(timezone.utc).isoformat(),
                    "actorRole": self.active_role if self.active_role in VALID_USER_ROLES else None,
                    "unlinkedPaaIds": [],
                    "knownPeers": peer_directory,
                }
    @staticmethod
    def merge_collection(
        name: str,
        base: dict,
        local: dict,
        remote: dict,
        local_role: object = None,
        remote_role: object = None,
    ) -> list[dict]:
        base_items = {item["id"]: item for item in base.get(name, [])}
        local_items = {item["id"]: item for item in local[name]}
        remote_items = {item["id"]: item for item in remote[name]}
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
                queue = next(
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
    remaining = sorted(results - {primary_address})
    final_addresses = ([primary_address] if primary_address else []) + remaining
    with _LAN_CACHE_LOCK:
        _LAN_ADDRESSES_CACHE = final_addresses
        _LAN_ADDRESSES_CACHE_TIME = now
    return final_addresses
def ensure_mobile_tls_certificates(directory: Path, addresses: list[str]) -> tuple[Path, Path, Path, str]:
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
        if origin and self.is_local_origin(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Vary", "Origin")
    @staticmethod
    def is_local_origin(origin: str) -> bool:
        try:
            return origin == f"http://127.0.0.1:{PORT}"
        except ValueError:
            return False
    def is_local_app_request(self) -> bool:
        origin = self.headers.get("Origin")
        return (
            self.is_local_loopback_request()
            and bool(origin)
            and self.is_local_origin(origin)
        )
    def is_local_app_read_request(self) -> bool:
        origin = self.headers.get("Origin")
        return (
            self.is_local_loopback_request()
            and (not origin or self.is_local_origin(origin))
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
        host = self.headers.get("Host", "").split(":")[0] or self.client_address[0]
        https_url = f"https://{host}:{MOBILE_PORT}/"
        ca_url = f"http://{host}:{PORT}/api/mobile-ca"
        fingerprint = self.mobile_ca_fingerprint or "Não configurada"
        html = f"""




CRAS Desktop · Conectar Celular

:root {{
--primary: #1976d2;
--primary-dark: #115293;
--success: #2e7d32;
--bg: #f4f6f8;
--card-bg: #ffffff;
--text: #1e293b;
--text-muted: #64748b;
--border: #e2e8f0;
}}
* {{ box-sizing: border-box; margin: 0; padding: 0; }}
body {{
font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
background: var(--bg);
color: var(--text);
line-height: 1.5;
padding: 16px;
}}
.container {{
max-width: 540px;
margin: 0 auto;
}}
.header {{
text-align: center;
padding: 24px 0 16px;
}}
.logo-badge {{
display: inline-block;
background: #e3f2fd;
color: var(--primary);
font-weight: 700;
padding: 6px 14px;
border-radius: 20px;
font-size: 14px;
margin-bottom: 8px;
}}
h1 {{
font-size: 24px;
font-weight: 700;
color: #0f172a;
margin-bottom: 6px;
}}
p.subtitle {{
color: var(--text-muted);
font-size: 15px;
}}
.card {{
background: var(--card-bg);
border-radius: 16px;
padding: 20px;
margin-bottom: 16px;
box-shadow: 0 2px 8px rgba(0,0,0,0.06);
border: 1px solid var(--border);
}}
.card-title {{
font-size: 17px;
font-weight: 700;
margin-bottom: 12px;
display: flex;
align-items: center;
gap: 8px;
}}
.step-number {{
background: var(--primary);
color: #fff;
width: 24px;
height: 24px;
border-radius: 50%;
display: inline-flex;
align-items: center;
justify-content: center;
font-size: 13px;
font-weight: bold;
}}
.btn {{
display: block;
width: 100%;
text-align: center;
padding: 14px 20px;
border-radius: 12px;
font-weight: 600;
font-size: 16px;
text-decoration: none;
transition: all 0.2s ease;
cursor: pointer;
border: none;
}}
.btn-download {{
background: #e0f2fe;
color: #0369a1;
border: 1px solid #bae6fd;
margin-bottom: 14px;
}}
.btn-download:hover, .btn-download:active {{
background: #bae6fd;
}}
.btn-open {{
background: var(--success);
color: #ffffff;
box-shadow: 0 4px 12px rgba(46,125,50,0.25);
}}
.btn-open:hover, .btn-open:active {{
background: #1b5e20;
}}
.tabs {{
display: flex;
gap: 6px;
margin-bottom: 12px;
background: #f1f5f9;
padding: 4px;
border-radius: 10px;
}}
.tab-btn {{
flex: 1;
padding: 8px 12px;
border: none;
background: transparent;
font-weight: 600;
font-size: 14px;
border-radius: 8px;
cursor: pointer;
color: var(--text-muted);
}}
.tab-btn.active {{
background: #ffffff;
color: var(--primary);
box-shadow: 0 1px 3px rgba(0,0,0,0.1);
}}
.tab-content {{
display: none;
font-size: 14px;
color: #334155;
}}
.tab-content.active {{
display: block;
}}
ol {{
padding-left: 20px;
margin-top: 8px;
}}
li {{
margin-bottom: 8px;
}}
li strong {{
color: #0f172a;
}}
.fingerprint-box {{
background: #f8fafc;
border: 1px dashed #cbd5e1;
border-radius: 8px;
padding: 8px 12px;
font-family: monospace;
font-size: 12px;
word-break: break-all;
color: #475569;
margin-top: 8px;
}}
.badge-status {{
display: inline-flex;
align-items: center;
gap: 6px;
font-size: 13px;
font-weight: 600;
color: #166534;
background: #dcfce7;
padding: 4px 10px;
border-radius: 12px;
margin-bottom: 12px;
}}
.status-dot {{
width: 8px;
height: 8px;
background: #22c55e;
border-radius: 50%;
}}





CRAS Desktop · Rede Local
Conectar pelo Celular
Acesse a fila e os atendimentos com rapidez e segurança
1
Instalar o Certificado de Segurança


O certificado raiz autoriza a criptografia segura HTTPS no celular.


<a class="btn btn-download" href="{ca_url}">📥 Baixar Certificado CA (.crt)</a>
🤖 Android
🍏 iPhone (iOS)
Toque no botão Baixar Certificado CA acima.
Abra as Configurações do Android.
Vá em Segurança e privacidade (ou Biometria e segurança).
Toque em Mais configurações de segurança (ou Credenciais) → Instalar certificado.
Escolha Certificado CA, toque em Instalar mesmo assim e selecione o arquivo baixado.

Abra esta página no Safari e toque em Baixar Certificado CA.
Autorize o download. Abra os Ajustes e toque em Perfil Baixado → Instalar.
Em seguida, vá em Ajustes → Geral → Sobre → Ajustes de Confiança do Certificado.
Ative a chave de Confiança Total para o CRAS Desktop Mobile CA.

Impressão digital SHA-256 do certificado:

{fingerprint}
2
Acessar o CRAS Desktop



Servidor Seguro Ativo na porta {MOBILE_PORT}


Após instalar o certificado no celular, toque no botão abaixo:


<a class="btn btn-open" href="{https_url}">🚀 Abrir CRAS Desktop Seguro (HTTPS)</a>


function selectTab(os) {{
document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
if (os === 'android') {{
document.querySelectorAll('.tab-btn')[0].classList.add('active');
document.getElementById('tab-android').classList.add('active');
}} else {{
document.querySelectorAll('.tab-btn')[1].classList.add('active');
document.getElementById('tab-ios').classList.add('active');
}}
}}


        """
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
        if not origin or not self.is_local_origin(origin):
            self.send_error(403)
            return
        self.send_response(204)
        self.add_cors_headers(origin)
        self.send_header("Content-Length", "0")
        self.end_headers()
    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path == "/api/mobile-info":
            if not self.is_private_network_request() or (
                not self.is_local_loopback_request() and not self.is_secure_mobile_request()
            ):
                self.send_error(403)
                return
            info = self.store.mobile_access_info()
            info["ready"] = self.store.ready
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
                "port": PORT,
                "addresses": addresses,
                "revision": self.store.get_revision(),
                "ready": self.store.ready,
                "mobilePort": MOBILE_PORT,
                "mobileCaFingerprint": self.mobile_ca_fingerprint,
                "mobileHttpsReady": self.mobile_https_ready,
            }
            if local_request:
                info["pairingKey"] = self.store.pairing_key
                info["manualAddresses"] = self.store.get_manual_addresses()
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
                messages = self.store.list_chat_messages(limit, before)
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
                attachment = self.store.chat_attachment(query.get("id", [""])[0])
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
        if file_name not in ("CRAS.html", "dexie.min.js"):
            self.send_error(404)
            return
        file_path = self.ui_root / file_name
        try:
            body = file_path.read_bytes()
        except OSError:
            logging.exception("Não foi possível ler o recurso %s.", file_name)
            self.send_error(500, "Não foi possível carregar a interface.")
            return
        content_type = "text/html; charset=utf-8" if file_name.endswith(".html") else "application/javascript; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)
    def do_POST(self) -> None:
        path = urlsplit(self.path).path
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
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0 or length > MAX_BODY_BYTES:
                    raise ValueError("Tamanho da mensagem sincronizada inválido.")
                envelope = json.loads(self.rfile.read(length).decode("utf-8"))
                salt, payload = decode_envelope(envelope, self.store.pairing_key)
                message = self.store.store_chat_message(payload.get("message"))
                self.send_json(
                    200,
                    encode_envelope(salt, self.store.pairing_key, {"messageId": message["id"]}),
                    origin,
                )
            except InvalidTag:
                self.send_json(400, {"error": "Código de pareamento incorreto ou mensagem adulterada."}, origin)
            except (ValueError, json.JSONDecodeError) as error:
                self.send_json(400, {"error": str(error)}, origin)
            except Exception:
                logging.exception("Não foi possível receber uma mensagem P2P do chat.")
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
                    }
                    self.send_json(200, encode_mobile_payload(key, result))
                    return
                if operation != "write":
                    raise ValueError("Operação móvel inválida.")
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
        if path == "/api/local-peer-directory":
            if not self.is_local_app_request():
                self.send_error(403)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0 or length > 256 * 1024:
                    raise ValueError("Tamanho da lista de computadores inválido.")
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                if not isinstance(payload, dict) or "peers" not in payload:
                    raise ValueError("A lista de computadores vinculados está inválida.")
                count = self.store.set_peer_directory(payload["peers"])
                self.send_json(200, {"count": count}, self.headers.get("Origin"))
            except (ValueError, json.JSONDecodeError) as error:
                self.send_json(400, {"error": str(error)}, self.headers.get("Origin"))
            except Exception:
                logging.exception("Não foi possível salvar a lista local de computadores.")
                self.send_json(500, {"error": "Não foi possível salvar os computadores vinculados."},
                               self.headers.get("Origin"))
            return
        if path == "/api/local-manual-addresses":
            if not self.is_local_app_request():
                self.send_error(403)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0 or length > 16 * 1024:
                    raise ValueError("Tamanho da lista de endereços inválido.")
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                if not isinstance(payload, dict) or "addresses" not in payload:
                    raise ValueError("Informe a lista de endereços IP manuais.")
                addresses = self.store.set_manual_addresses(payload["addresses"])
                self.send_json(200, {"manualAddresses": addresses}, self.headers.get("Origin"))
            except (ValueError, json.JSONDecodeError) as error:
                self.send_json(400, {"error": str(error)}, self.headers.get("Origin"))
            except Exception:
                logging.exception("Não foi possível salvar os endereços IP manuais.")
                self.send_json(500, {"error": "Não foi possível salvar os endereços IP manuais."},
                               self.headers.get("Origin"))
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
                logging.exception("Falha ao persistir o estado P2P local.")
                self.send_json(500, {"error": "Não foi possível salvar o estado local de sincronização."}, origin)
            return
        if path != "/api/sync":
            self.send_error(404)
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
            salt, payload = decode_envelope(envelope, self.store.pairing_key)
            result = self.store.sync(
                payload.get("peerId"),
                payload.get("requestId"),
                payload.get("localSnapshot"),
                payload.get("resolutions"),
                payload.get("actorRole"),
                payload.get("knownPeers"),
            )
            self.send_json(200, encode_envelope(salt, self.store.pairing_key, result), origin)
        except Exception as error:
            logging.exception("Falha ao processar sincronização de um par.")
            message = "Não foi possível validar ou processar a sincronização."
            if isinstance(error, InvalidTag):
                message = "Código de pareamento incorreto ou pacote de sincronização adulterado."
            if isinstance(error, ValueError):
                message = str(error)
            self.send_json(400, {"error": message}, origin)
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
            ensure_mobile_tls_certificates(user_data / "mobile-tls", lan_addresses())
        )
    except Exception as error:
        logging.exception("Não foi possível preparar o acesso HTTPS móvel.")
        show_startup_error(
            "Não foi possível preparar o certificado HTTPS para o celular. "
            "O aplicativo continuará disponível neste computador.\n\n"
            f"Detalhe: {error}"
        )
    CRASRequestHandler.store = store
    CRASRequestHandler.ui_root = resource_path(".")
    CRASRequestHandler.mobile_ca_path = mobile_ca_path
    CRASRequestHandler.mobile_ca_fingerprint = mobile_ca_fingerprint
    try:
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
if __name__ == "__main__":
    main()
