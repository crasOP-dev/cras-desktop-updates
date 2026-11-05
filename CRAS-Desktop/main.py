from __future__ import annotations

import base64
from contextlib import closing
import hashlib
import json
import logging
import os
import re
import secrets
import socket
import sqlite3
import subprocess
import sys
import threading
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import webview
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC


APP_NAME = "CRAS-Desktop"
GITHUB_REPOSITORY = "crasOP-dev/cras-desktop-updates"
GITHUB_RELEASES_API = f"https://api.github.com/repos/{GITHUB_REPOSITORY}/releases/latest"
UPDATE_ASSET_NAME = "CRAS-Desktop.exe"
MAX_UPDATE_BYTES = 250 * 1024 * 1024
PORT = 8765
MAX_BODY_BYTES = 12 * 1024 * 1024
MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024
PBKDF2_ITERATIONS = 200_000
EMPTY_SNAPSHOT = {"appointments": [], "paaRecords": [], "settings": {}}
VALID_USER_ROLES = {"assistant", "caseworker", "reception", "admin"}
MISSING = object()


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
    with urlopen(request, timeout=8) as response:
        release = json.loads(response.read().decode("utf-8"))
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
        with urlopen(request, timeout=30) as response:
            content = response.read(MAX_UPDATE_BYTES + 1)
        if len(content) > MAX_UPDATE_BYTES:
            raise ValueError("O arquivo de atualização excede o limite permitido.")
        return content

    executable = download(release["executable_url"])
    checksum_text = download(release["checksum_url"]).decode("ascii").strip()
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
    script = f"""$ErrorActionPreference = 'Stop'
$appProcessId = {process_id}
$source = {powershell_literal(str(update_path))}
$target = {powershell_literal(str(executable_path))}
$staged = "$target.update"
$backup = "$target.previous"
try {{
    if (Get-Process -Id $appProcessId -ErrorAction SilentlyContinue) {{
        Wait-Process -Id $appProcessId -Timeout 120
    }}
    Copy-Item -LiteralPath $source -Destination $staged -Force
    Move-Item -LiteralPath $target -Destination $backup -Force
    try {{
        Move-Item -LiteralPath $staged -Destination $target -Force
    }} catch {{
        Move-Item -LiteralPath $backup -Destination $target -Force
        throw
    }}
    Start-Process -FilePath $target
    Remove-Item -LiteralPath $backup, $source -Force
    Remove-Item -LiteralPath $PSCommandPath -Force
}} catch {{
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
        "A atualização não foi concluída. O CRAS Desktop anterior foi mantido, quando possível.`n`n$($_.Exception.Message)",
        "CRAS Desktop",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
}}
"""
    script_path.write_text(script, encoding="utf-8")
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


def derive_key(password: str, salt: bytes) -> bytes:
    return PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=PBKDF2_ITERATIONS,
    ).derive(password.encode("utf-8"))


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
                    "INSERT OR IGNORE INTO current_snapshot (id, payload) VALUES (1, ?)",
                    (canonical(EMPTY_SNAPSHOT),),
                )
                self.node_id = self.get_or_create(db, "node_id", str(uuid.uuid4()))
                self.pairing_key = self.get_or_create(db, "pairing_key", secrets.token_urlsafe(24))
                self.active_role = self.get_or_create(db, "active_role", "")

    def connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=15)
        db.execute("PRAGMA journal_mode=WAL")
        return db

    @staticmethod
    def get_or_create(db: sqlite3.Connection, key: str, value: str) -> str:
        row = db.execute("SELECT value FROM metadata WHERE key = ?", (key,)).fetchone()
        if row:
            return str(row[0])
        db.execute("INSERT INTO metadata (key, value) VALUES (?, ?)", (key, value))
        return value

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
    ) -> dict:
        if not self.ready:
            raise ValueError("O outro computador ainda está inicializando. Tente sincronizar novamente em instantes.")
        if not isinstance(peer_id, str) or not peer_id.strip() or len(peer_id) > 100:
            raise ValueError("Identificação do computador remoto inválida.")
        if not isinstance(request_id, str) or not request_id.strip() or len(request_id) > 100:
            raise ValueError("Identificação da solicitação inválida.")
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
                revision = db.execute("SELECT revision FROM current_snapshot WHERE id = 1").fetchone()[0]
                return {
                    "status": "ok",
                    "snapshot": merged,
                    "revision": revision,
                    "syncedAt": datetime.now(timezone.utc).isoformat(),
                    "actorRole": self.active_role if self.active_role in VALID_USER_ROLES else None,
                    "unlinkedPaaIds": [],
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
            base_value = base_items.get(item_id)
            local_value = local_items.get(item_id)
            remote_value = remote_items.get(item_id)
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
                    if role == "reception":
                        return 90
                    return 80 if role == preferred_role else 10
                if ".routeServices" in f".{path}" and role == "reception":
                    return 90
                return 80 if role == "reception" else 10
            if collection == "paaRecords":
                return 80 if role == "reception" else 10
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


def lan_addresses() -> list[str]:
    results: set[str] = set()
    try:
        for item in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            address = item[4][0]
            if not address.startswith("127.") and not address.startswith("169.254."):
                results.add(address)
    except OSError:
        logging.exception("Não foi possível detectar os endereços da rede local.")
    return sorted(results)


class CRASRequestHandler(BaseHTTPRequestHandler):
    store: PeerStore
    ui_root: Path

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

    def is_local_loopback_request(self) -> bool:
        return self.client_address[0] in ("127.0.0.1", "::1")

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
        if path == "/api/info":
            local_request = self.client_address[0] in ("127.0.0.1", "::1")
            query = parse_qs(urlsplit(self.path).query)
            info = {
                "nodeId": self.store.node_id,
                "port": PORT,
                "addresses": lan_addresses(),
                "revision": self.store.get_revision(),
                "ready": self.store.ready,
            }
            if local_request:
                info["pairingKey"] = self.store.pairing_key
                if query.get("details") == ["1"]:
                    info["addresses"] = lan_addresses()
            self.send_json(200, info, self.headers.get("Origin"))
            return
        if path == "/api/local-snapshot":
            if not self.is_local_loopback_request():
                self.send_error(403)
                return
            self.send_json(200, self.store.get_local_state())
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
    if check_for_update():
        return
    CRASRequestHandler.store = store
    CRASRequestHandler.ui_root = resource_path(".")

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


if __name__ == "__main__":
    main()
