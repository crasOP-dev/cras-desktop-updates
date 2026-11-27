import gzip
import base64
import hashlib
import io
import json
import sys
import tempfile
import unittest
from concurrent.futures import Future
from contextlib import closing
from unittest.mock import Mock, patch
from pathlib import Path

import truststore
import main
from cryptography import x509
from cryptography.exceptions import InvalidTag

from main import (
    CentralServiceAdvertiser,
    CRASRequestHandler,
    PORT,
    PeerStore,
    RevisionConflict,
    decode_envelope,
    decode_mobile_payload,
    download_update,
    encode_envelope,
    encode_mobile_payload,
    ensure_mobile_tls_certificates,
    check_for_update,
    discover_central_services,
    launch_update_helper,
    lan_addresses,
    latest_release,
    require_compatible_sync_version,
    verify_update_checksum,
    validate_chat_message,
    user_authentication_proof,
    version_tuple,
)


class VersionTests(unittest.TestCase):
    def test_parses_release_versions(self):
        self.assertEqual(version_tuple("v1.2.3"), (1, 2, 3))
        self.assertEqual(version_tuple("1.2.3"), (1, 2, 3))

    def test_rejects_non_semver_release_tags(self):
        with self.assertRaises(ValueError):
            version_tuple("latest")

    def test_sync_versions_must_match_exactly(self):
        with patch("main.app_version", return_value="2.0.14"):
            require_compatible_sync_version("v2.0.14")
            for client_version in (None, "2.0.13", "latest"):
                with self.subTest(client_version=client_version), self.assertRaisesRegex(
                    ValueError, "Atualize todos os dispositivos"
                ):
                    require_compatible_sync_version(client_version)

    def test_verifies_update_checksum(self):
        executable = b"release binary"
        checksum = hashlib.sha256(executable).hexdigest()
        verify_update_checksum(executable, f"{checksum}  CRAS-Desktop.exe")
        with self.assertRaisesRegex(ValueError, "checksum"):
            verify_update_checksum(executable, "0" * 64)

    def test_update_helper_uses_unicode_script_and_logs_installation(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = Path(temporary_directory)
            update_path = directory / "CRAS-Desktop-update.exe"
            executable_path = directory / "CRAS Desktop.exe"
            update_path.write_bytes(b"updated binary")

            with patch("main.subprocess.Popen") as mocked_popen:
                launch_update_helper(update_path, executable_path, 1234, directory)

            script_path = directory / "apply-update.ps1"
            self.assertTrue(script_path.read_bytes().startswith(b"\xef\xbb\xbf"))
            script = script_path.read_text(encoding="utf-8-sig")
            self.assertIn("[System.IO.File]::Replace($staged, $target, $backup)", script)
            self.assertIn("Move-Item -LiteralPath $staged -Destination $target", script)
            self.assertIn("A versão anterior foi restaurada.", script)
            self.assertIn(str(directory / "update.log"), script)
            self.assertEqual(mocked_popen.call_args.args[0][-1], str(script_path))

    def test_declining_startup_update_does_not_download_or_launch(self):
        root = Mock()
        tkinter_module = Mock()
        tkinter_module.Tk.return_value = root
        messagebox_module = Mock()
        messagebox_module.askyesno.return_value = False
        tkinter_module.messagebox = messagebox_module
        with patch.object(main.sys, "frozen", True, create=True), patch.object(
            main.os, "name", "nt"
        ), patch(
            "main.latest_release", return_value={"version": "v2.0.6"}
        ), patch.dict(
            sys.modules,
            {"tkinter": tkinter_module, "tkinter.messagebox": messagebox_module},
        ), patch("main.download_update") as download, patch(
            "main.launch_update_helper"
        ) as launch:
            self.assertFalse(check_for_update())
        download.assert_not_called()
        launch.assert_not_called()

    def test_update_downloads_use_system_certificate_store(self):
        executable = b"release binary"
        checksum = f"{hashlib.sha256(executable).hexdigest()}  CRAS-Desktop.exe"

        def response_for(content):
            response = Mock()
            response.__enter__ = Mock(return_value=response)
            response.__exit__ = Mock(return_value=False)
            response.read.side_effect = [content, b""]
            return response

        release = {
            "executable_url": "https://github.com/crasOP-dev/cras-desktop-updates/releases/download/v1.1.2/CRAS-Desktop.exe",
            "checksum_url": "https://github.com/crasOP-dev/cras-desktop-updates/releases/download/v1.1.2/CRAS-Desktop.exe.sha256",
        }
        with tempfile.TemporaryDirectory() as temporary_directory, patch(
            "main.urlopen",
            side_effect=[
                response_for(executable),
                response_for(checksum.encode("ascii")),
            ],
        ) as mocked_urlopen:
            path = download_update(release, Path(temporary_directory))
            self.assertEqual(path.read_bytes(), executable)
            self.assertEqual(mocked_urlopen.call_count, 2)
            for call in mocked_urlopen.call_args_list:
                self.assertIsInstance(call.kwargs["context"], truststore.SSLContext)

    def test_latest_release_uses_system_certificate_store(self):
        release_payload = {
            "tag_name": "v1.1.2",
            "assets": [
                {
                    "name": "CRAS-Desktop.exe",
                    "browser_download_url": (
                        "https://github.com/crasOP-dev/cras-desktop-updates/"
                        "releases/download/v1.1.2/CRAS-Desktop.exe"
                    ),
                },
                {
                    "name": "CRAS-Desktop.exe.sha256",
                    "browser_download_url": (
                        "https://github.com/crasOP-dev/cras-desktop-updates/"
                        "releases/download/v1.1.2/CRAS-Desktop.exe.sha256"
                    ),
                },
            ],
        }
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.return_value = json.dumps(release_payload).encode("utf-8")

        with patch("main.urlopen", return_value=response) as mocked_urlopen, patch(
            "main.app_version", return_value="1.1.1"
        ):
            release = latest_release()

        self.assertEqual(release["version"], "v1.1.2")
        self.assertEqual(
            mocked_urlopen.call_args.args[0].full_url,
            "https://api.github.com/repos/crasOP-dev/cras-desktop-updates/releases/latest",
        )
        context = mocked_urlopen.call_args.kwargs["context"]
        self.assertIsInstance(context, truststore.SSLContext)


class PeerStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.store = PeerStore(Path(self.temp_dir.name) / "test.sqlite3")
        self.store.save_local_snapshot({"appointments": [], "paaRecords": [], "settings": {}}, 0)

    def tearDown(self):
        self.temp_dir.cleanup()

    @staticmethod
    def technical_e2ee_snapshot(ciphertext=None):
        sealed = ciphertext or {
            "version": 1,
            "nonce": base64.b64encode(b"\x00" * 12).decode("ascii"),
            "ciphertext": base64.b64encode(b"\x01" * 16).decode("ascii"),
        }
        return {
            "appointments": [{
                "id": "appointment-1",
                "annotations": {"assistencia": [], "cadastro": []},
                "technicalAnnotationsCiphertext": sealed,
            }],
            "people": [],
            "paaRecords": [],
            "settings": {
                main.TECHNICAL_E2EE_SETTING: {
                    "version": 1,
                    "keyCheck": sealed,
                }
            },
        }

    def test_technical_e2ee_snapshot_rejects_plaintext_annotations(self):
        snapshot = self.technical_e2ee_snapshot()
        snapshot["appointments"][0]["annotations"]["assistencia"] = [{
            "id": "note-1",
            "text": "Dado sensível",
            "authorName": "Técnica",
            "authorRole": "assistant",
            "attendanceDate": "2026-01-02T10:00:00Z",
            "createdAt": "2026-01-02T10:05:00Z",
        }]

        with self.assertRaisesRegex(ValueError, "sem criptografia ponta a ponta"):
            main.validate_snapshot(snapshot)

    def test_technical_e2ee_snapshot_is_stored_without_plaintext_notes(self):
        snapshot = self.technical_e2ee_snapshot()
        snapshot["appointments"][0]["annotations"]["cadastro"] = []

        self.store.save_local_snapshot(snapshot, self.store.get_revision(), "assistant")

        stored = json.dumps(self.store.get_local_state()["snapshot"], ensure_ascii=False)
        self.assertNotIn("Dado sensível", stored)
        self.assertIn("technicalAnnotationsCiphertext", stored)

    def test_technical_e2ee_rejects_legacy_peer_sync_after_activation(self):
        self.store.save_local_snapshot(
            self.technical_e2ee_snapshot(),
            self.store.get_revision(),
            "assistant",
        )
        legacy_snapshot = {
            "appointments": [],
            "people": [],
            "paaRecords": [],
            "settings": {},
        }

        with self.assertRaisesRegex(ValueError, "ainda não usa a criptografia técnica"):
            self.store.sync("old-peer", "legacy-request", legacy_snapshot, {}, "assistant")

    def test_technical_e2ee_migration_replaces_plaintext_server_and_peer_bases(self):
        technical_entry = {
            "id": "note-1",
            "text": "Conteúdo técnico que não pode permanecer legível",
            "authorName": "Técnica",
            "authorRole": "assistant",
            "attendanceDate": "2026-01-02T10:00:00Z",
            "createdAt": "2026-01-02T10:05:00Z",
        }
        legacy = {
            "appointments": [{
                "id": "appointment-1",
                "annotations": {"assistencia": [technical_entry], "cadastro": []},
            }],
            "people": [],
            "paaRecords": [],
            "settings": {},
        }
        self.store.sync("peer-1", "legacy", legacy, {}, "assistant")
        encrypted = self.technical_e2ee_snapshot()

        self.store.sync("peer-1", "enable-e2ee", encrypted, {}, "assistant")

        with closing(self.store.connect()) as db:
            snapshot_payload = db.execute(
                "SELECT payload FROM current_snapshot WHERE id = 1"
            ).fetchone()[0]
            peer_payloads = [
                row[0] for row in db.execute("SELECT payload FROM peer_bases").fetchall()
            ]
        self.assertNotIn(technical_entry["text"], snapshot_payload)
        self.assertTrue(peer_payloads)
        self.assertTrue(all(technical_entry["text"] not in payload for payload in peer_payloads))

    def test_nontechnical_peer_cannot_replace_encrypted_annotations(self):
        initial = self.technical_e2ee_snapshot()
        self.store.save_local_snapshot(initial, self.store.get_revision(), "assistant")
        self.store.sync("peer-tech", "initial", initial, {}, "assistant")
        updated = self.technical_e2ee_snapshot({
            "version": 1,
            "nonce": base64.b64encode(b"\x02" * 12).decode("ascii"),
            "ciphertext": base64.b64encode(b"\x03" * 16).decode("ascii"),
        })
        updated["settings"][main.TECHNICAL_E2EE_SETTING]["keyCheck"] = (
            initial["settings"][main.TECHNICAL_E2EE_SETTING]["keyCheck"]
        )

        result = self.store.sync("peer-tech", "unauthorized-update", updated, {}, "caseworker")

        self.assertEqual(
            result["snapshot"]["appointments"][0]["technicalAnnotationsCiphertext"],
            initial["appointments"][0]["technicalAnnotationsCiphertext"],
        )

    def test_nontechnical_peer_cannot_delete_appointment_with_encrypted_annotations(self):
        initial = self.technical_e2ee_snapshot()
        self.store.save_local_snapshot(initial, self.store.get_revision(), "assistant")
        self.store.sync("peer-tech", "initial", initial, {}, "assistant")
        updated = {
            "appointments": [],
            "people": [],
            "paaRecords": [],
            "settings": initial["settings"],
        }

        result = self.store.sync("peer-tech", "unauthorized-delete", updated, {}, "caseworker")

        self.assertEqual(len(result["snapshot"]["appointments"]), 1)
        self.assertEqual(
            result["snapshot"]["appointments"][0]["technicalAnnotationsCiphertext"],
            initial["appointments"][0]["technicalAnnotationsCiphertext"],
        )

    def test_nontechnical_peer_cannot_add_encrypted_annotations(self):
        initial = self.technical_e2ee_snapshot()
        initial["appointments"] = []
        self.store.save_local_snapshot(initial, self.store.get_revision(), "assistant")
        self.store.sync("peer-tech", "initial", initial, {}, "assistant")
        updated = self.technical_e2ee_snapshot()
        updated["settings"] = initial["settings"]

        result = self.store.sync("peer-tech", "unauthorized-add", updated, {}, "caseworker")

        self.assertNotIn(
            "technicalAnnotationsCiphertext",
            result["snapshot"]["appointments"][0],
        )

    def test_technical_e2ee_rejects_a_different_group_key(self):
        initial = self.technical_e2ee_snapshot()
        self.store.save_local_snapshot(initial, self.store.get_revision(), "assistant")
        different_key = self.technical_e2ee_snapshot({
            "version": 1,
            "nonce": base64.b64encode(b"\x04" * 12).decode("ascii"),
            "ciphertext": base64.b64encode(b"\x05" * 16).decode("ascii"),
        })

        with self.assertRaisesRegex(ValueError, "não corresponde ao servidor"):
            self.store.sync("different-key-peer", "wrong-key", different_key, {}, "assistant")

    def test_server_assigns_stable_sequential_person_ids(self):
        self.store.set_central_server(True)
        first_snapshot = {
            "appointments": [{
                "id": "appointment-1",
                "createdAt": "2026-01-02T10:00:00Z",
                "nome": "Pessoa Um",
                "cpf": "",
                "personKey": "person-1",
            }],
            "people": [{
                "key": "person-1",
                "id": None,
                "name": "Pessoa Um",
                "cpf": "",
                "createdAt": "2026-01-02T10:00:00Z",
            }],
            "paaRecords": [],
            "settings": {},
        }
        self.store.save_local_snapshot(first_snapshot, self.store.get_revision())
        first_state = self.store.get_local_state()["snapshot"]
        self.assertEqual(first_state["people"][0]["id"], 1)
        self.assertEqual(first_state["appointments"][0]["personId"], 1)

        next_snapshot = {
            "appointments": [{
                "id": "appointment-2",
                "createdAt": "2026-01-03T10:00:00Z",
                "nome": "Pessoa Dois",
                "cpf": "",
                "personKey": "person-2",
            }],
            "people": [{
                "key": "person-2",
                "id": None,
                "name": "Pessoa Dois",
                "cpf": "",
                "createdAt": "2026-01-03T10:00:00Z",
            }],
            "paaRecords": [],
            "settings": {},
        }
        self.store.save_local_snapshot(next_snapshot, self.store.get_revision())
        next_state = self.store.get_local_state()["snapshot"]
        self.assertEqual(next_state["people"][0]["id"], 2)

    def test_old_appointments_group_only_on_matching_cpf_and_name(self):
        self.store.set_central_server(True)
        snapshot = {
            "appointments": [
                {"id": "same-1", "createdAt": "2026-01-01T10:00:00Z", "nome": "Ana Silva", "cpf": "12345678901"},
                {"id": "same-2", "createdAt": "2026-01-02T10:00:00Z", "nome": " Ana   Silva ", "cpf": "123.456.789-01"},
                {"id": "different-name", "createdAt": "2026-01-03T10:00:00Z", "nome": "Ana Souza", "cpf": "12345678901"},
                {"id": "no-cpf-1", "createdAt": "2026-01-04T10:00:00Z", "nome": "Pessoa Sem CPF", "cpf": ""},
                {"id": "no-cpf-2", "createdAt": "2026-01-05T10:00:00Z", "nome": "Pessoa Sem CPF", "cpf": ""},
            ],
            "people": [],
            "paaRecords": [],
            "settings": {},
        }

        self.store.save_local_snapshot(snapshot, self.store.get_revision())

        state = self.store.get_local_state()["snapshot"]
        people_by_appointment = {
            record["id"]: record["personKey"] for record in state["appointments"]
        }
        self.assertEqual(people_by_appointment["same-1"], people_by_appointment["same-2"])
        self.assertEqual(len(set(people_by_appointment.values())), 4)
        self.assertNotEqual(people_by_appointment["different-name"], people_by_appointment["same-1"])
        self.assertNotEqual(people_by_appointment["no-cpf-1"], people_by_appointment["no-cpf-2"])

    def test_concurrent_professional_annotations_merge_by_category(self):
        base = {
            "appointments": [{
                "id": "appointment-1",
                "annotations": {"assistencia": [], "cadastro": []},
            }],
            "paaRecords": [],
            "settings": {},
        }
        technical_entry = {
            "id": "note-technical",
            "text": "Anotação técnica",
            "authorName": "Técnica",
            "authorRole": "assistant",
            "attendanceDate": "2026-01-02T10:00:00Z",
            "createdAt": "2026-01-02T10:05:00Z",
        }
        registration_entry = {
            "id": "note-registration",
            "text": "Anotação cadastral",
            "authorName": "Cadastradora",
            "authorRole": "caseworker",
            "attendanceDate": "2026-01-02T10:00:00Z",
            "createdAt": "2026-01-02T10:06:00Z",
        }
        local = {
            **base,
            "appointments": [{
                **base["appointments"][0],
                "annotations": {"assistencia": [technical_entry], "cadastro": []},
                "_syncMeta": {"last": {"role": "assistant", "updatedAt": "2026-01-02T10:05:00Z"}},
            }],
        }
        remote = {
            **base,
            "appointments": [{
                **base["appointments"][0],
                "annotations": {"assistencia": [], "cadastro": [registration_entry]},
                "_syncMeta": {"last": {"role": "caseworker", "updatedAt": "2026-01-02T10:06:00Z"}},
            }],
        }

        merged = PeerStore.merge_collection(
            "appointments", base, local, remote, "assistant", "caseworker"
        )

        self.assertEqual(merged[0]["annotations"]["assistencia"], [technical_entry])
        self.assertEqual(merged[0]["annotations"]["cadastro"], [registration_entry])

    def test_snapshot_rejects_annotations_saved_under_the_wrong_professional_category(self):
        snapshot = {
            "appointments": [{
                "id": "appointment-1",
                "annotations": {
                    "cadastro": [{
                        "id": "note-1",
                        "text": "Anotação",
                        "authorName": "Técnica",
                        "authorRole": "assistant",
                        "attendanceDate": "2026-01-02T10:00:00Z",
                        "createdAt": "2026-01-02T10:05:00Z",
                    }]
                },
            }],
            "people": [],
            "paaRecords": [],
            "settings": {},
        }

        with self.assertRaisesRegex(ValueError, "categoria"):
            main.validate_snapshot(snapshot)

    def test_transfer_package_restores_complete_server_on_new_machine(self):
        self.store.set_central_server(True)
        snapshot = {
            "appointments": [{
                "id": "appointment-1",
                "createdAt": "2026-01-02T10:00:00Z",
                "nome": "Pessoa Um",
                "cpf": "",
                "personKey": "person-1",
                "annotations": {"assistencia": [], "cadastro": []},
            }],
            "people": [{
                "key": "person-1",
                "id": None,
                "name": "Pessoa Um",
                "cpf": "",
                "createdAt": "2026-01-02T10:00:00Z",
            }],
            "paaRecords": [],
            "settings": {},
        }
        self.store.save_local_snapshot(snapshot, self.store.get_revision())
        self.store.register_user_credential(
            "user-1",
            {"salt": base64.b64encode(b"0123456789abcdef").decode("ascii"), "hash": "a" * 64},
            "Admin",
            "admin",
        )
        with closing(self.store.connect()) as db:
            with db:
                db.execute(
                    "INSERT INTO chat_messages (id, created_at, month, payload, author_id, recipient_id) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    ("message-1", "2026-01-02T10:00:00Z", "2026-01", "{}", "user-1", None),
                )

        package = self.store.create_transfer_package()
        destination = PeerStore(Path(self.temp_dir.name) / "replacement.sqlite3")
        destination_node_id = destination.node_id

        revision = destination.restore_transfer_package(package)

        self.assertTrue(destination.is_central_server())
        self.assertTrue(destination.ready)
        self.assertEqual(destination.node_id, destination_node_id)
        restored = destination.get_local_state()["snapshot"]
        self.assertEqual(restored["appointments"][0]["personId"], 1)
        self.assertEqual(restored["people"][0]["id"], 1)
        self.assertEqual(destination.get_user_profile("user-1"), {"name": "Admin", "role": "admin"})
        with closing(destination.connect()) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM chat_messages").fetchone()[0], 1)
        self.assertEqual(revision, destination.get_revision())
        package.unlink()

    def test_central_server_exports_machine_readable_records_without_settings(self):
        self.assertFalse(self.store.machine_export_path.exists())
        self.store.set_central_server(True)
        snapshot = {
            "appointments": [{
                "id": "appointment-1",
                "nome": "Pessoa atendida",
                "_syncMeta": {"role": "admin"},
                "service": {"_syncMeta": {"role": "assistant"}, "route": "Cadastro Único"},
            }],
            "paaRecords": [{"id": "paa-1", "nome": "Pessoa do PAA"}],
            "settings": {
                "cras-ouro-preto-usuarios-v1": [{
                    "id": "user-1",
                    "passwordCredential": {"hash": "secret-hash"},
                }],
                "syncToken": "secret-token",
            },
        }

        self.store.save_local_snapshot(snapshot, self.store.get_revision())

        exported = json.loads(self.store.machine_export_path.read_text(encoding="utf-8"))
        self.assertEqual(exported["format"], main.MACHINE_EXPORT_FORMAT)
        self.assertEqual(exported["version"], main.MACHINE_EXPORT_VERSION)
        self.assertEqual(exported["appointments"][0]["service"], {"route": "Cadastro Único"})
        self.assertEqual(exported["paaRecords"], snapshot["paaRecords"])
        self.assertEqual(exported["people"][0]["id"], 1)
        self.assertEqual(exported["people"][0]["name"], "Pessoa atendida")
        self.assertNotIn("key", exported["people"][0])
        self.assertNotIn("settings", exported)
        self.assertNotIn("secret-hash", self.store.machine_export_path.read_text(encoding="utf-8"))
        self.assertNotIn("secret-token", self.store.machine_export_path.read_text(encoding="utf-8"))
        self.assertEqual(self.store.machine_export_status()["revision"], self.store.get_revision())

    def test_machine_export_tracks_central_peer_sync(self):
        self.store.set_central_server(True)
        local_snapshot = {
            "appointments": [{"id": "appointment-1", "nome": "Pessoa atendida"}],
            "paaRecords": [],
            "settings": {},
        }

        result = self.store.sync("peer-1", "request-1", local_snapshot, {}, "reception")

        exported = json.loads(self.store.machine_export_path.read_text(encoding="utf-8"))
        self.assertEqual(exported["appointments"][0]["id"], "appointment-1")
        self.assertNotIn("personKey", exported["appointments"][0])
        self.assertEqual(exported["appointments"][0]["personId"], 1)
        self.assertEqual(exported["revision"], result["revision"])

    def test_reception_wins_concurrent_attendance_edits_without_prompt(self):
        base = {
            "appointments": [{"id": "appointment-1", "nome": "Base"}],
            "paaRecords": [],
            "settings": {},
        }
        self.assertEqual(self.store.sync("peer-a", "request-1", base, {})["status"], "ok")
        self.assertEqual(self.store.sync("peer-b", "request-2", base, {})["status"], "ok")

        peer_b = {
            "appointments": [{"id": "appointment-1", "nome": "Alteração B"}],
            "paaRecords": [],
            "settings": {},
        }
        self.assertEqual(self.store.sync("peer-b", "request-3", peer_b, {}, "assistant")["status"], "ok")

        peer_a = {
            "appointments": [{"id": "appointment-1", "nome": "Alteração A"}],
            "paaRecords": [],
            "settings": {},
        }
        self.store.save_local_snapshot(peer_b, self.store.get_revision(), "assistant")
        resolved = self.store.sync("peer-a", "request-4", peer_a, {}, "reception")
        self.assertEqual(resolved["status"], "ok")
        self.assertEqual(resolved["snapshot"]["appointments"][0]["nome"], "Alteração A")

    def test_deleting_appointment_does_not_create_invalid_record(self):
        base = {
            "appointments": [{"id": "appointment-1", "nome": "Atendimento"}],
            "paaRecords": [],
            "settings": {},
        }
        self.store.save_local_snapshot(base, self.store.get_revision())
        self.store.sync("peer-a", "seed-a", base, {})
        self.store.sync("peer-b", "seed-b", base, {})

        deleted = {"appointments": [], "paaRecords": [], "settings": {}}
        result = self.store.sync("peer-a", "delete-a", deleted, {})
        self.assertEqual(result["snapshot"]["appointments"], [])

        result = self.store.sync("peer-b", "propagate-delete", base, {})
        self.assertEqual(result["snapshot"]["appointments"], [])

    def test_admin_wins_concurrent_attendance_edits(self):
        base = {
            "appointments": [{"id": "appointment-1", "nome": "Base"}],
            "paaRecords": [],
            "settings": {},
        }
        self.store.sync("peer-admin", "admin-base", base, {}, "admin")
        admin_snapshot = {
            **base,
            "appointments": [{
                "id": "appointment-1",
                "nome": "Admin",
                "_syncMeta": {
                    "last": {"role": "admin", "updatedAt": "2026-01-02T00:00:00Z"},
                    "general": {"role": "admin", "updatedAt": "2026-01-02T00:00:00Z"},
                },
            }],
        }
        self.store.save_local_snapshot(admin_snapshot, self.store.get_revision(), "admin")
        reception_snapshot = {
            **base,
            "appointments": [{
                "id": "appointment-1",
                "nome": "Recepção",
                "_syncMeta": {
                    "last": {"role": "reception", "updatedAt": "2026-01-03T00:00:00Z"},
                    "general": {"role": "reception", "updatedAt": "2026-01-03T00:00:00Z"},
                },
            }],
        }

        result = self.store.sync("peer-admin", "admin-wins", reception_snapshot, {}, "reception")
        self.assertEqual(result["snapshot"]["appointments"][0]["nome"], "Admin")

    def test_merges_independent_fields_without_overwriting_either_change(self):
        base = {
            "appointments": [{
                "id": "appointment-1",
                "nome": "Base",
                "routeServices": [{
                    "id": "service-1",
                    "states": {"assistencia": {"startedAt": "", "finished": False}},
                }],
            }],
            "paaRecords": [],
            "settings": {},
        }
        local = {
            **base,
            "appointments": [{
                **base["appointments"][0],
                "nome": "Nome atualizado",
                "_syncMeta": {
                    "last": {"role": "reception", "updatedAt": "2026-01-02T00:00:00Z"},
                    "general": {"role": "reception", "updatedAt": "2026-01-02T00:00:00Z"},
                },
            }],
        }
        remote = {
            **base,
            "appointments": [{
                **base["appointments"][0],
                "routeServices": [{
                    "id": "service-1",
                    "states": {"assistencia": {
                        "startedAt": "2026-01-02T10:00:00Z",
                        "finished": False,
                    }},
                }],
                "_syncMeta": {
                    "last": {"role": "assistant", "updatedAt": "2026-01-02T10:00:00Z"},
                    "queues": {
                        "assistencia": {"role": "assistant", "updatedAt": "2026-01-02T10:00:00Z"}
                    },
                },
            }],
        }

        merged = PeerStore.merge_collection(
            "appointments", base, local, remote, "reception", "assistant"
        )
        record = merged[0]
        self.assertEqual(record["nome"], "Nome atualizado")
        self.assertEqual(
            record["routeServices"][0]["states"]["assistencia"]["startedAt"],
            "2026-01-02T10:00:00Z",
        )

    def test_queue_authority_is_specific_to_assistance_and_cadastro(self):
        for queue, preferred_role, other_role in (
            ("assistencia", "assistant", "caseworker"),
            ("cadastro", "caseworker", "assistant"),
        ):
            base = {
                "appointments": [{
                    "id": "appointment-1",
                    "routeServices": [{
                        "id": "service-1",
                        "states": {queue: {"startedAt": ""}},
                    }],
                }],
                "paaRecords": [],
                "settings": {},
            }
            preferred_snapshot = {
                "appointments": [{
                    **base["appointments"][0],
                    "routeServices": [{
                        "id": "service-1",
                        "states": {queue: {"startedAt": "preferred"}},
                    }],
                    "_syncMeta": {
                        "last": {"role": preferred_role, "updatedAt": "2026-01-02T10:00:00Z"},
                        "queues": {
                            queue: {"role": preferred_role, "updatedAt": "2026-01-02T10:00:00Z"}
                        },
                    },
                }],
                "paaRecords": [],
                "settings": {},
            }
            other_snapshot = {
                "appointments": [{
                    **base["appointments"][0],
                    "routeServices": [{
                        "id": "service-1",
                        "states": {queue: {"startedAt": "other"}},
                    }],
                    "_syncMeta": {
                        "last": {"role": other_role, "updatedAt": "2026-01-02T11:00:00Z"},
                        "queues": {
                            queue: {"role": other_role, "updatedAt": "2026-01-02T11:00:00Z"}
                        },
                    },
                }],
                "paaRecords": [],
                "settings": {},
            }

            merged = PeerStore.merge_collection(
                "appointments",
                base,
                preferred_snapshot,
                other_snapshot,
                preferred_role,
                other_role,
            )
            self.assertEqual(
                merged[0]["routeServices"][0]["states"][queue]["startedAt"],
                "preferred",
            )

    def test_reception_can_finish_either_queue_during_sync(self):
        for queue, specialist_role in (
            ("assistencia", "assistant"),
            ("cadastro", "caseworker"),
        ):
            base = {
                "appointments": [{
                    "id": "appointment-1",
                    "routeServices": [{
                        "id": "service-1",
                        "states": {queue: {"finishedAt": ""}},
                    }],
                }],
                "paaRecords": [],
                "settings": {},
            }
            reception_snapshot = {
                **base,
                "appointments": [{
                    **base["appointments"][0],
                    "routeServices": [{
                        "id": "service-1",
                        "states": {queue: {"finishedAt": "reception-finished"}},
                    }],
                    "_syncMeta": {
                        "last": {"role": "reception", "updatedAt": "2026-01-02T10:00:00Z"},
                        "queues": {
                            queue: {"role": "reception", "updatedAt": "2026-01-02T10:00:00Z"}
                        },
                    },
                }],
            }
            specialist_snapshot = {
                **base,
                "appointments": [{
                    **base["appointments"][0],
                    "routeServices": [{
                        "id": "service-1",
                        "states": {queue: {"finishedAt": "specialist-finished"}},
                    }],
                    "_syncMeta": {
                        "last": {"role": specialist_role, "updatedAt": "2026-01-02T11:00:00Z"},
                        "queues": {
                            queue: {"role": specialist_role, "updatedAt": "2026-01-02T11:00:00Z"}
                        },
                    },
                }],
            }

            merged = PeerStore.merge_collection(
                "appointments",
                base,
                reception_snapshot,
                specialist_snapshot,
                "reception",
                specialist_role,
            )
            self.assertEqual(
                merged[0]["routeServices"][0]["states"][queue]["finishedAt"],
                "reception-finished",
            )

    def test_rejects_replayed_successful_request(self):
        snapshot = {"appointments": [], "paaRecords": [], "settings": {}}
        self.store.sync("peer-a", "replay-me", snapshot, {})
        with self.assertRaisesRegex(ValueError, "repetida"):
            self.store.sync("peer-a", "replay-me", snapshot, {})

    def test_refuses_stale_local_revision(self):
        snapshot = {"appointments": [], "paaRecords": [], "settings": {}}
        with self.assertRaises(RevisionConflict):
            self.store.save_local_snapshot(snapshot, 0)

    def test_user_credential_is_idempotent_and_cannot_be_replaced(self):
        credential = {
            "salt": base64.b64encode(b"0123456789abcdef").decode("ascii"),
            "hash": "a" * 64,
        }
        self.store.register_user_credential("user-1", credential, "Técnica", "assistant")
        self.store.register_user_credential("user-1", credential, "Técnica", "assistant")
        self.store.register_user_credential("user-1", credential, "Nome falsificado", "admin")

        self.assertEqual(self.store.get_user_credential("user-1"), "a" * 64)
        self.assertEqual(
            self.store.get_user_profile("user-1"),
            {"name": "Técnica", "role": "assistant"},
        )
        with self.assertRaisesRegex(ValueError, "já possui"):
            self.store.register_user_credential("user-1", {
                **credential,
                "hash": "b" * 64,
            }, "Técnica", "assistant")

    def test_central_server_role_persists(self):
        self.store.set_central_server(True)

        self.assertTrue(PeerStore(self.store.path).is_central_server())
        self.store.set_central_server(False)
        self.assertFalse(self.store.is_central_server())

    def test_legacy_shared_pairing_and_ip_configuration_is_removed(self):
        with closing(self.store.connect()) as db:
            db.execute("INSERT INTO metadata (key, value) VALUES ('pairing_key', 'old-secret')")
            db.execute("INSERT INTO metadata (key, value) VALUES ('manual_addresses', '[]')")
        PeerStore(self.store.path)

        with closing(self.store.connect()) as db:
            keys = {row[0] for row in db.execute("SELECT key FROM metadata")}
        self.assertNotIn("pairing_key", keys)
        self.assertNotIn("manual_addresses", keys)

    def test_principal_backup_is_compressed_and_contains_restorable_history(self):
        snapshot = {
            "appointments": [{
                "id": "appointment-1",
                "nome": "Histórico preservado",
                "personKey": "person-1",
                "personId": None,
                "annotations": {
                    "assistencia": [{
                        "id": "note-1",
                        "text": "Anotação preservada",
                        "authorName": "Técnica",
                        "authorRole": "assistant",
                        "attendanceDate": "2026-01-02T10:00:00Z",
                        "createdAt": "2026-01-02T10:05:00Z",
                    }],
                    "cadastro": [],
                },
            }],
            "people": [{
                "key": "person-1",
                "id": None,
                "name": "Histórico preservado",
                "cpf": "",
                "createdAt": "2026-01-02T10:00:00Z",
            }],
            "paaRecords": [],
            "settings": {"cras-ouro-preto-encaminhamentos-v1": ["Cadastro Único"]},
        }
        self.store.save_local_snapshot(snapshot, self.store.get_revision())
        self.store.set_principal(True)

        backup_path = self.store.create_auto_backup()
        with gzip.open(backup_path, "rt", encoding="utf-8") as backup_file:
            backup = json.load(backup_file)

        self.assertTrue(self.store.is_principal())
        self.assertEqual(backup["format"], "cras-ouro-preto-backup")
        self.assertEqual(backup["appointments"], snapshot["appointments"])
        self.assertEqual(backup["people"], snapshot["people"])
        self.assertEqual(backup["routes"], ["Cadastro Único"])
        self.assertEqual(backup_path.parent.name, "backups")

    def test_auto_backup_status_reports_latest_backup_and_enabled_state(self):
        self.store.save_local_snapshot(
            {"appointments": [], "paaRecords": [], "settings": {}},
            self.store.get_revision(),
        )
        self.assertEqual(
            self.store.auto_backup_status(),
            {"enabled": False, "backup": "", "createdAt": ""},
        )

        self.store.set_principal(True)
        backup_path = self.store.create_auto_backup()
        status = self.store.auto_backup_status()

        self.assertTrue(status["enabled"])
        self.assertEqual(status["backup"], backup_path.name)
        self.assertTrue(status["createdAt"])

    def test_principal_backup_keeps_at_most_thirty_copies(self):
        self.store.save_local_snapshot(
            {"appointments": [], "paaRecords": [], "settings": {}},
            self.store.get_revision(),
        )
        self.store.set_principal(True)
        backup_directory = self.store.path.parent / "backups"
        backup_directory.mkdir()
        for day in range(31):
            (backup_directory / f"cras-system-backup-2020-01-{day + 1:02}.json.gz").touch()

        self.store.create_auto_backup()

        self.assertEqual(len(list(backup_directory.glob("cras-system-backup-*.json.gz"))), 30)

    def test_chat_messages_are_deduplicated_and_archive_before_monthly_cleanup(self):
        message = {
            "id": "chat-message-1",
            "createdAt": "2020-01-15T12:00:00Z",
            "authorId": "user-1",
            "authorName": "Técnica",
            "authorRole": "assistant",
            "text": "Recomendo acompanhar esta pessoa.",
            "person": {
                "id": "appointment-1",
                "name": "Pessoa Exemplo",
                "cpfMasked": "***.***.***-42",
            },
            "attachment": {
                "name": "documento.png",
                "type": "image/png",
                "data": "iVBORw0KGgo=",
            },
        }
        self.store.store_chat_message(message)
        self.store.store_chat_message(message)

        visible_messages = self.store.list_chat_messages()
        self.assertEqual(len(visible_messages), 1)
        self.assertNotIn("data", visible_messages[0]["attachment"])
        self.assertEqual(
            self.store.chat_attachment("chat-message-1"),
            ("image/png", b"\x89PNG\r\n\x1a\n"),
        )

        archives = self.store.archive_old_chat_messages()

        with gzip.open(archives[0], "rt", encoding="utf-8") as archive_file:
            archived_messages = json.load(archive_file)
        self.assertEqual(archived_messages[0]["id"], "chat-message-1")
        self.assertEqual(archived_messages[0]["attachment"]["data"], "iVBORw0KGgo=")
        self.assertEqual(self.store.list_chat_messages(), [])

    def test_chat_rejects_non_image_payloads(self):
        message = {
            "id": "chat-message-2",
            "createdAt": "2026-01-15T12:00:00Z",
            "authorId": "user-1",
            "authorName": "Técnica",
            "authorRole": "assistant",
            "text": "",
            "attachment": {
                "name": "document.svg",
                "type": "image/svg+xml",
                "data": "PHN2Zy8+",
            },
        }
        with self.assertRaisesRegex(ValueError, "anexo"):
            validate_chat_message(message)

    def test_chat_lists_only_the_selected_general_or_direct_conversation(self):
        general = {
            "id": "general",
            "createdAt": "2026-01-15T12:00:00Z",
            "authorId": "user-a",
            "authorName": "Técnica A",
            "authorRole": "assistant",
            "text": "Aviso geral",
        }
        direct = {
            "id": "direct",
            "createdAt": "2026-01-15T12:01:00Z",
            "authorId": "user-a",
            "authorName": "Técnica A",
            "authorRole": "assistant",
            "recipientId": "user-b",
            "text": "Mensagem privada",
        }
        other_direct = {
            **direct,
            "id": "other-direct",
            "recipientId": "user-c",
        }
        for message in (general, direct, other_direct):
            self.store.store_chat_message(message)

        self.assertEqual(
            [message["id"] for message in self.store.list_chat_messages(user_id="user-b")],
            ["general"],
        )
        self.assertEqual(
            [message["id"] for message in self.store.list_chat_messages(
                user_id="user-b", recipient_id="user-a"
            )],
            ["direct"],
        )
        self.assertEqual(
            self.store.list_chat_messages(user_id="user-b", recipient_id="user-c"),
            [],
        )

    def test_chat_attachment_is_available_only_to_conversation_participants(self):
        self.store.store_chat_message({
            "id": "private-image",
            "createdAt": "2026-01-15T12:00:00Z",
            "authorId": "user-a",
            "authorName": "Técnica A",
            "authorRole": "assistant",
            "recipientId": "user-b",
            "text": "Imagem privada",
            "attachment": {
                "name": "documento.png",
                "type": "image/png",
                "data": "iVBORw0KGgo=",
            },
        })

        self.assertIsNone(self.store.chat_attachment("private-image", "user-c", "user-a"))
        self.assertEqual(
            self.store.chat_attachment("private-image", "user-b", "user-a"),
            ("image/png", b"\x89PNG\r\n\x1a\n"),
        )


class EncryptionTests(unittest.TestCase):
    def test_round_trip_and_reject_wrong_pairing_code(self):
        salt = b"0123456789abcdef"
        payload = {"peerId": "node-a", "localSnapshot": {"appointments": []}}
        envelope = encode_envelope(salt, "shared-pairing-code", payload)
        decoded_salt, decoded_payload = decode_envelope(envelope, "shared-pairing-code")
        self.assertEqual(decoded_salt, salt)
        self.assertEqual(decoded_payload, payload)
        with self.assertRaises(InvalidTag):
            decode_envelope(envelope, "incorrect-code")

    def test_mobile_payload_is_encrypted_and_authenticated(self):
        key = b"m" * 32
        payload = {"operation": "read", "snapshot": {"appointments": []}}
        envelope = encode_mobile_payload(key, payload)
        self.assertEqual(decode_mobile_payload(envelope, key), payload)
        with self.assertRaises(InvalidTag):
            decode_mobile_payload(envelope, b"x" * 32)


class MobileAccessTests(unittest.TestCase):
    def test_mobile_addresses_prioritize_the_active_default_route(self):
        probe = Mock()
        probe.getsockname.return_value = ("192.168.1.25", 0)
        address_lookup = [
            (2, 1, 6, "", ("10.0.0.9", 0)),
            (2, 1, 6, "", ("169.254.1.1", 0)),
            (2, 1, 6, "", ("127.0.0.1", 0)),
        ]
        with patch("main._LAN_ADDRESSES_CACHE", None), patch(
            "main.windows_interface_addresses", return_value=[]
        ), patch("main.socket.socket") as socket_factory, patch(
            "main.socket.getaddrinfo", return_value=address_lookup
        ), patch(
            "main.socket.gethostbyname_ex",
            return_value=("cras-host", [], ["10.0.0.9", "192.168.1.25"]),
        ):
            socket_factory.return_value.__enter__.return_value = probe
            self.assertEqual(lan_addresses(), ["192.168.1.25", "10.0.0.9"])

    def test_mobile_addresses_include_static_interface_addresses(self):
        with patch("main._LAN_ADDRESSES_CACHE", None), patch(
            "main.windows_interface_addresses",
            return_value=["192.168.1.40", "10.0.0.15"],
        ), patch("main.socket.socket", side_effect=OSError), patch(
            "main.socket.getaddrinfo", return_value=[]
        ), patch(
            "main.socket.gethostbyname_ex", return_value=("cras-host", [], [])
        ):
            self.assertEqual(lan_addresses(), ["10.0.0.15", "192.168.1.40"])

    def test_mobile_addresses_exclude_non_private_and_reserved_interfaces(self):
        with patch("main._LAN_ADDRESSES_CACHE", None), patch(
            "main.windows_interface_addresses",
            return_value=["192.168.3.115", "100.64.1.2", "203.0.113.17", "8.8.8.8"],
        ), patch("main.socket.socket", side_effect=OSError), patch(
            "main.socket.getaddrinfo", return_value=[]
        ), patch(
            "main.socket.gethostbyname_ex", return_value=("cras-host", [], [])
        ):
            self.assertEqual(lan_addresses(), ["192.168.3.115"])

    def test_mobile_access_uses_a_salted_key_and_requires_a_long_code(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            store = PeerStore(Path(temporary_directory) / "mobile.sqlite3")
            info = store.mobile_access_info()
            self.assertFalse(info["enabled"])

            with self.assertRaisesRegex(ValueError, "12 e 128"):
                store.configure_mobile_access("short")

            store.configure_mobile_access("a-long-team-code")
            info = store.mobile_access_info()
            self.assertTrue(info["enabled"])
            self.assertEqual(len(info["salt"]), 24)
            self.assertEqual(len(store.mobile_access_key()), 32)

            store.configure_mobile_access("")
            self.assertFalse(store.mobile_access_info()["enabled"])
            self.assertIsNone(store.mobile_access_key())

    def test_intern_role_is_accepted_and_has_reception_queue_priority(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            store = PeerStore(Path(temporary_directory) / "mobile.sqlite3")
            store.save_local_snapshot(
                {"appointments": [], "paaRecords": [], "settings": {}},
                0,
                "intern",
            )
            self.assertEqual(store.get_local_state()["actorRole"], "intern")
            self.assertTrue(PeerStore.local_has_precedence(
                "appointments",
                "routeServices.service.assistanceAcquiredBy",
                None,
                None,
                "intern",
                "assistant",
            ))

    def test_mobile_tls_certificate_is_signed_by_a_persistent_local_ca(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = Path(temporary_directory)
            ca_path, server_path, key_path, fingerprint = ensure_mobile_tls_certificates(
                directory,
                ["192.168.1.25"],
                "cras-central.local",
            )
            ca_cert = x509.load_pem_x509_certificate(ca_path.read_bytes())
            server_cert = x509.load_pem_x509_certificate(server_path.read_bytes())
            names = server_cert.extensions.get_extension_for_class(
                x509.SubjectAlternativeName
            ).value
            self.assertIn("192.168.1.25", [str(value) for value in names.get_values_for_type(x509.IPAddress)])
            self.assertIn("cras-central.local", names.get_values_for_type(x509.DNSName))
            self.assertTrue(fingerprint)
            self.assertTrue(key_path.exists())

            second_ca_path, _, _, second_fingerprint = ensure_mobile_tls_certificates(
                directory,
                ["192.168.1.25"],
                "cras-central.local",
            )
            self.assertEqual(second_ca_path.read_bytes(), ca_path.read_bytes())
            self.assertEqual(second_fingerprint, fingerprint)
            self.assertEqual(server_cert.issuer, ca_cert.subject)
            ca_ski = ca_cert.extensions.get_extension_for_class(x509.SubjectKeyIdentifier).value
            server_aki = server_cert.extensions.get_extension_for_class(x509.AuthorityKeyIdentifier).value
            server_ski = server_cert.extensions.get_extension_for_class(x509.SubjectKeyIdentifier).value
            self.assertEqual(server_aki.key_identifier, ca_ski.digest)
            self.assertTrue(server_ski.digest)


class MobileChatOriginTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.store = PeerStore(Path(self.temp_dir.name) / "mobile-chat-origin.sqlite3")
        self.user = {
            "id": "mobile-user",
            "name": "Técnica",
            "color": "#123456",
            "role": "assistant",
        }
        self.store.save_local_snapshot(
            {
                "appointments": [],
                "paaRecords": [],
                "settings": {"cras-ouro-preto-usuarios-v1": [self.user]},
            },
            0,
            "admin",
        )

    def tearDown(self):
        self.temp_dir.cleanup()

    def register_request(self, host, origin):
        body = json.dumps({
            "userId": self.user["id"],
            "name": self.user["name"],
            "role": self.user["role"],
            "credential": {
                "salt": base64.b64encode(b"0123456789abcdef").decode("ascii"),
                "hash": "a" * 64,
            },
        }).encode("utf-8")
        handler = object.__new__(CRASRequestHandler)
        handler.path = "/api/user/register"
        handler.headers = {
            "Content-Length": str(len(body)),
            "Host": host,
            "Origin": origin,
        }
        handler.client_address = ("192.168.1.25", 12345)
        handler.rfile = io.BytesIO(body)
        handler.store = self.store
        handler.is_secure_mobile_request = Mock(return_value=True)
        handler.send_json = Mock()
        handler.send_error = Mock()

        handler.do_POST()

        if handler.send_json.called:
            return handler.send_json.call_args.args[:2]
        return handler.send_error.call_args.args[0], {}

    def test_mobile_same_origin_can_register_user_credential_for_chat(self):
        status, result = self.register_request(
            "cras-central.local:8766",
            "https://cras-central.local:8766",
        )

        self.assertEqual(status, 200)
        self.assertEqual(result["registered"], True)
        self.assertEqual(self.store.get_user_credential(self.user["id"]), "a" * 64)

    def test_mobile_user_registration_rejects_an_origin_other_than_request_host(self):
        status, _ = self.register_request(
            "cras-central.local:8766",
            "https://attacker.local:8766",
        )

        self.assertEqual(status, 403)
        self.assertIsNone(self.store.get_user_credential(self.user["id"]))


class CentralChatSyncTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.store = PeerStore(Path(self.temp_dir.name) / "chat.sqlite3")
        self.user_id = "user-1"
        self.credential = {
            "salt": base64.b64encode(b"0123456789abcdef").decode("ascii"),
            "hash": "a" * 64,
        }
        self.store.register_user_credential(
            self.user_id, self.credential, "Técnica", "assistant"
        )

    def tearDown(self):
        self.temp_dir.cleanup()

    def request(self, payload, expected_status=200, user_id=None, credential_hash=None):
        salt = b"0123456789abcdef"
        user_id = user_id or self.user_id
        credential_hash = credential_hash or self.credential["hash"]
        payload = {**payload, "userId": user_id}
        envelope = encode_envelope(salt, credential_hash, payload)
        envelope["userId"] = user_id
        body = json.dumps(envelope).encode("utf-8")
        handler = object.__new__(CRASRequestHandler)
        handler.path = "/api/chat/sync"
        handler.headers = {"Content-Length": str(len(body))}
        handler.client_address = ("192.168.1.25", 12345)
        handler.rfile = io.BytesIO(body)
        handler.store = self.store
        handler.send_json = Mock()

        handler.do_POST()

        status, response = handler.send_json.call_args.args[:2]
        self.assertEqual(status, expected_status)
        if status != 200:
            return response
        _, result = decode_envelope(response, credential_hash)
        return result

    def test_server_chat_supports_message_delivery_and_offline_history_fetch(self):
        message = {
            "id": "chat-message-1",
            "createdAt": "2026-01-15T12:00:00Z",
            "authorId": "user-1",
            "authorName": "Técnica",
            "authorRole": "assistant",
            "text": "Mensagem central",
            "attachment": {
                "name": "documento.png",
                "type": "image/png",
                "data": "iVBORw0KGgo=",
            },
        }

        acknowledgement = self.request({"operation": "send", "message": message})
        history = self.request({"operation": "list", "limit": 50})
        attachment = self.request({
            "operation": "attachment",
            "messageId": message["id"],
        })

        self.assertEqual(acknowledgement, {"messageId": message["id"]})
        self.assertEqual(history["messages"][0]["id"], message["id"])
        self.assertNotIn("data", history["messages"][0]["attachment"])
        self.assertEqual(attachment["attachment"], {
            "type": "image/png",
            "data": "iVBORw0KGgo=",
        })

    def test_server_delivers_direct_message_to_authenticated_recipient(self):
        recipient_id = "user-2"
        recipient_hash = "b" * 64
        self.store.register_user_credential(
            recipient_id,
            {
                "salt": base64.b64encode(b"fedcba9876543210").decode("ascii"),
                "hash": recipient_hash,
            },
            "Técnico",
            "assistant",
        )
        message = {
            "id": "direct-message-1",
            "createdAt": "2026-01-15T12:00:00Z",
            "authorId": self.user_id,
            "authorName": "Técnica",
            "authorRole": "assistant",
            "recipientId": recipient_id,
            "text": "Mensagem para o destinatário",
        }

        self.request({"operation": "send", "message": message})
        history = self.request(
            {
                "operation": "list",
                "limit": 50,
                "recipientId": self.user_id,
            },
            user_id=recipient_id,
            credential_hash=recipient_hash,
        )

        self.assertEqual(
            [item["id"] for item in history["messages"]],
            ["direct-message-1"],
        )

    def test_server_chat_rejects_requests_outside_private_network(self):
        handler = object.__new__(CRASRequestHandler)
        handler.path = "/api/chat/sync"
        handler.client_address = ("8.8.8.8", 12345)
        handler.headers = {}
        handler.send_error = Mock()
        handler.send_json = Mock()

        handler.do_POST()

        handler.send_error.assert_called_once_with(403)
        handler.send_json.assert_not_called()

    def test_server_chat_does_not_expose_other_users_private_messages(self):
        for message_id, recipient_id in (("visible", "user-2"), ("private", "user-3")):
            self.store.store_chat_message({
                "id": message_id,
                "createdAt": "2026-01-15T12:00:00Z",
                "authorId": self.user_id,
                "authorName": "Técnica",
                "authorRole": "assistant",
                "recipientId": recipient_id,
                "text": "Mensagem individual",
            })

        history = self.request({
            "operation": "list",
            "limit": 50,
            "recipientId": "user-2",
        })

        self.assertEqual([message["id"] for message in history["messages"]], ["visible"])

    def test_server_chat_rejects_spoofed_author_role(self):
        error = self.request({
            "operation": "send",
            "message": {
                "id": "spoofed-role",
                "createdAt": "2026-01-15T12:00:00Z",
                "authorId": self.user_id,
                "authorName": "Técnica",
                "authorRole": "admin",
                "text": "Mensagem",
            },
        }, expected_status=400)

        self.assertIn("usuário autenticado", error["error"])


class CentralSyncAuthenticationTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.store = PeerStore(Path(self.temp_dir.name) / "sync.sqlite3")
        self.store.save_local_snapshot(
            {"appointments": [], "paaRecords": [], "settings": {}},
            self.store.get_revision(),
        )
        self.user_id = "user-1"
        self.credential = {
            "salt": base64.b64encode(b"0123456789abcdef").decode("ascii"),
            "hash": "c" * 64,
        }
        self.store.register_user_credential(
            self.user_id, self.credential, "Técnica", "assistant"
        )

    def tearDown(self):
        self.temp_dir.cleanup()

    def request(self, user_id, key, client_version=None, include_client_version=True):
        payload = {
            "peerId": "workstation-1",
            "requestId": "sync-request-1",
            "localSnapshot": {"appointments": [], "paaRecords": [], "settings": {}},
            "resolutions": {},
            "userId": user_id,
        }
        if include_client_version:
            payload["clientVersion"] = client_version or main.app_version()
        envelope = encode_envelope(b"0123456789abcdef", key, payload)
        envelope["userId"] = user_id
        body = json.dumps(envelope).encode("utf-8")
        handler = object.__new__(CRASRequestHandler)
        handler.path = "/api/sync"
        handler.headers = {"Content-Length": str(len(body))}
        handler.client_address = ("192.168.1.25", 12345)
        handler.rfile = io.BytesIO(body)
        handler.store = self.store
        handler.send_json = Mock()

        handler.do_POST()

        return handler.send_json.call_args.args[:2]

    def authentication_request(self, path, payload):
        body = json.dumps(payload).encode("utf-8")
        handler = object.__new__(CRASRequestHandler)
        handler.path = path
        handler.headers = {
            "Content-Length": str(len(body)),
            "Origin": f"http://127.0.0.1:{PORT}",
        }
        handler.client_address = ("192.168.1.25", 12345)
        handler.rfile = io.BytesIO(body)
        handler.store = self.store
        handler.send_json = Mock()
        handler.send_error = Mock()

        handler.do_POST()

        if handler.send_json.called:
            return handler.send_json.call_args.args[:2]
        return handler.send_error.call_args.args[0], {}

    def test_sync_uses_registered_individual_credential(self):
        status, response = self.request(self.user_id, self.credential["hash"])

        self.assertEqual(status, 200)
        _, result = decode_envelope(response, self.credential["hash"])
        self.assertEqual(result["status"], "ok")

    def test_sync_rejects_an_unregistered_user(self):
        status, response = self.request("unknown-user", self.credential["hash"])

        self.assertEqual(status, 401)
        self.assertIn("senha individual", response["error"].lower())

    def test_sync_rejects_a_different_or_missing_client_version_without_writing(self):
        initial_revision = self.store.get_revision()
        for client_version, include_client_version in (
            ("2.0.13", True),
            (None, False),
        ):
            with self.subTest(client_version=client_version):
                with patch("main.logging.exception"):
                    status, response = self.request(
                        self.user_id,
                        self.credential["hash"],
                        client_version,
                        include_client_version,
                    )
                self.assertEqual(status, 400)
                self.assertIn("versões incompatíveis", response["error"].lower())
                self.assertEqual(self.store.get_revision(), initial_revision)

    def test_existing_server_password_can_restore_a_device_credential(self):
        status, response = self.authentication_request(
            "/api/user/auth-challenge",
            {"userId": "unknown-user"},
        )
        self.assertEqual(status, 404)
        self.assertIn("senha", response["error"].lower())

        status, challenge = self.authentication_request(
            "/api/user/auth-challenge",
            {"userId": self.user_id},
        )
        self.assertEqual(status, 200)
        self.assertNotIn("hash", challenge)

        proof = user_authentication_proof(
            self.credential["hash"],
            self.user_id,
            challenge["challengeId"],
            challenge["nonce"],
        )
        status, response = self.authentication_request(
            "/api/user/authenticate",
            {
                "userId": self.user_id,
                "challengeId": challenge["challengeId"],
                "proof": proof,
            },
        )

        self.assertEqual(status, 200)
        self.assertTrue(response["authenticated"])
        self.assertEqual(self.store.get_user_credential(self.user_id), self.credential["hash"])

        status, response = self.authentication_request(
            "/api/user/authenticate",
            {
                "userId": self.user_id,
                "challengeId": challenge["challengeId"],
                "proof": proof,
            },
        )
        self.assertEqual(status, 401)
        self.assertIn("desafio expirado", response["error"])

    def test_server_password_recovery_limits_failed_attempts(self):
        for _ in range(5):
            _, challenge = self.authentication_request(
                "/api/user/auth-challenge",
                {"userId": self.user_id},
            )
            status, _ = self.authentication_request(
                "/api/user/authenticate",
                {
                    "userId": self.user_id,
                    "challengeId": challenge["challengeId"],
                    "proof": "0" * 64,
                },
            )
            self.assertEqual(status, 401)

        status, response = self.authentication_request(
            "/api/user/auth-challenge",
            {"userId": self.user_id},
        )
        self.assertEqual(status, 429)
        self.assertIn("aguarde cinco minutos", response["error"].lower())

    @patch("main.HAVE_ZEROCONF", True)
    @patch("main.lan_addresses", return_value=["192.168.1.25"])
    @patch("main.Zeroconf")
    @patch("main.ServiceInfo")
    def test_central_advertiser_registers_and_unregisters_discovery_service(
        self, service_info, zeroconf_class, _
    ):
        advertiser = CentralServiceAdvertiser("1234567890abcdef")

        advertiser.set_enabled(True)
        advertiser.set_enabled(False)

        zeroconf = zeroconf_class.return_value
        zeroconf.register_service.assert_called_once_with(service_info.return_value)
        zeroconf.unregister_service.assert_called_once_with(service_info.return_value)
        zeroconf.close.assert_called_once()

    @patch("main.HAVE_ZEROCONF", True)
    @patch("main.time.sleep")
    @patch("main.ServiceBrowser")
    @patch("main.Zeroconf")
    def test_discovery_returns_only_private_central_endpoints(
        self, zeroconf_class, browser_class, _
    ):
        zeroconf = zeroconf_class.return_value
        info = Mock()
        info.properties = {b"nodeId": b"central-node"}
        info.port = PORT
        info.parsed_scoped_addresses.return_value = ["192.168.1.25", "8.8.8.8"]
        zeroconf.get_service_info.return_value = info

        def start_browser(instance, service_type, listener):
            listener.add_service(instance, service_type, "CRAS._cras-central._tcp.local.")
            return Mock()

        browser_class.side_effect = start_browser

        servers = discover_central_services()

        self.assertEqual(servers, [{
            "nodeId": "central-node",
            "endpoints": ["http://192.168.1.25:8765"],
        }])
        zeroconf.close.assert_called_once()

    @patch("main._scan_central_services")
    @patch("main.time.sleep")
    @patch("main.ServiceBrowser")
    @patch("main.Zeroconf")
    def test_discovery_uses_network_scan_when_mdns_has_no_result(
        self, zeroconf_class, browser_class, _, scan_services
    ):
        browser_class.return_value = Mock()
        scan_services.return_value = [{
            "nodeId": "central-node",
            "endpoints": ["http://192.168.1.25:8765"],
        }]

        servers = discover_central_services()

        self.assertEqual(servers, [{
            "nodeId": "central-node",
            "endpoints": ["http://192.168.1.25:8765"],
        }])
        scan_services.assert_called_once_with()

    @patch("main._probe_central_endpoint")
    @patch("main.lan_addresses", return_value=["192.168.3.120"])
    def test_network_scan_finds_central_service_on_local_subnet(
        self, _, probe_endpoint
    ):
        server = {
            "nodeId": "central-node",
            "endpoints": ["http://192.168.3.103:8765"],
        }
        probe_endpoint.side_effect = lambda address: (
            server if address == "192.168.3.103" else None
        )

        servers = main._scan_central_services()

        self.assertEqual(servers, [server])

    @patch("main.wait")
    @patch("main.ThreadPoolExecutor")
    @patch("main.lan_addresses", return_value=["192.168.3.120"])
    def test_network_scan_keeps_found_server_when_other_probes_are_pending(
        self, _, executor_class, wait_for_probes
    ):
        server = {
            "nodeId": "central-node",
            "endpoints": ["http://192.168.3.103:8765"],
        }
        executor = executor_class.return_value
        futures = []

        def submit_probe(probe, address):
            future = Future()
            if address == "192.168.3.103":
                future.set_result(server)
            futures.append(future)
            return future

        executor.submit.side_effect = submit_probe
        wait_for_probes.side_effect = lambda submitted, timeout: (
            {future for future in submitted if future.done()},
            {future for future in submitted if not future.done()},
        )

        servers = main._scan_central_services()

        self.assertEqual(servers, [server])
        self.assertEqual(
            sum(future.cancelled() for future in futures),
            len(futures) - 1,
        )
        executor.shutdown.assert_called_once_with(wait=False, cancel_futures=True)


class LocalAppRequestTests(unittest.TestCase):
    def test_local_origin_accepts_desktop_loopback_hosts_only_on_app_port(self):
        self.assertTrue(CRASRequestHandler.is_local_origin(f"http://127.0.0.1:{PORT}"))
        self.assertTrue(CRASRequestHandler.is_local_origin(f"http://localhost:{PORT}"))
        self.assertFalse(CRASRequestHandler.is_local_origin(f"http://localhost:{PORT + 1}"))
        self.assertFalse(CRASRequestHandler.is_local_origin("http://example.invalid:8765"))

    def test_local_reads_allow_missing_origin_but_reject_foreign_origin(self):
        handler = object.__new__(CRASRequestHandler)
        handler.client_address = ("127.0.0.1", 12345)
        handler.headers = {}
        self.assertTrue(handler.is_local_app_read_request())

        handler.headers = {"Origin": f"http://127.0.0.1:{PORT}"}
        self.assertTrue(handler.is_local_app_read_request())

        handler.headers = {"Origin": "https://example.invalid"}
        self.assertFalse(handler.is_local_app_read_request())

    def test_local_app_requests_accept_localhost_origin(self):
        handler = object.__new__(CRASRequestHandler)
        handler.client_address = ("127.0.0.1", 12345)
        handler.headers = {"Origin": f"http://localhost:{PORT}"}

        self.assertTrue(handler.is_local_app_request())

    def test_central_server_discovery_accepts_same_origin_get_without_origin_header(self):
        handler = object.__new__(CRASRequestHandler)
        handler.path = "/api/central-servers"
        handler.client_address = ("127.0.0.1", 12345)
        handler.headers = {}
        handler.send_error = Mock()
        handler.send_json = Mock()

        with patch("main.discover_central_services", return_value=[]):
            handler.do_GET()

        handler.send_error.assert_not_called()
        handler.send_json.assert_called_once_with(200, {"servers": []}, None)

    def test_backup_status_is_available_only_to_local_app_reads(self):
        handler = object.__new__(CRASRequestHandler)
        handler.path = "/api/backup-status"
        handler.client_address = ("127.0.0.1", 12345)
        handler.headers = {}
        handler.store = Mock()
        handler.store.auto_backup_status.return_value = {
            "enabled": True,
            "backup": "cras-system-backup-2026-11-25.json.gz",
            "createdAt": "2026-11-25T10:00:00-03:00",
        }
        handler.send_error = Mock()
        handler.send_json = Mock()

        handler.do_GET()

        handler.send_error.assert_not_called()
        handler.send_json.assert_called_once_with(
            200,
            handler.store.auto_backup_status.return_value,
            None,
        )

        handler.client_address = ("192.168.1.25", 12345)
        handler.send_json.reset_mock()
        handler.do_GET()
        handler.send_error.assert_called_once_with(403)
        handler.send_json.assert_not_called()

    def test_server_transfer_export_streams_package_only_to_local_app(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            package_path = Path(temporary_directory) / "transfer.sqlite3"
            package_path.write_bytes(b"sqlite-transfer")
            handler = object.__new__(CRASRequestHandler)
            handler.path = "/api/server-transfer/export"
            handler.client_address = ("127.0.0.1", 12345)
            handler.headers = {"Origin": f"http://127.0.0.1:{PORT}"}
            handler.store = Mock()
            handler.store.create_transfer_package.return_value = package_path
            handler.wfile = io.BytesIO()
            handler.send_response = Mock()
            handler.send_header = Mock()
            handler.add_cors_headers = Mock()
            handler.end_headers = Mock()

            handler.do_GET()

            handler.send_response.assert_called_once_with(200)
            handler.send_header.assert_any_call("Content-Type", "application/vnd.sqlite3")
            self.assertEqual(handler.wfile.getvalue(), b"sqlite-transfer")
            self.assertFalse(package_path.exists())

            handler.client_address = ("192.168.1.25", 12345)
            handler.send_error = Mock()
            handler.send_response.reset_mock()
            handler.do_GET()
            handler.send_error.assert_called_once_with(403)
            handler.send_response.assert_not_called()

    def test_server_transfer_import_restores_local_upload_and_enables_discovery(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            handler = object.__new__(CRASRequestHandler)
            handler.path = "/api/server-transfer/import"
            handler.client_address = ("127.0.0.1", 12345)
            handler.headers = {
                "Origin": f"http://127.0.0.1:{PORT}",
                "Content-Length": "15",
            }
            handler.store = Mock()
            handler.store.path = Path(temporary_directory) / "replacement.sqlite3"
            handler.store.restore_transfer_package.side_effect = (
                lambda path: self.assertEqual(path.read_bytes(), b"sqlite-transfer") or 8
            )
            handler.central_advertiser = Mock()
            handler.rfile = io.BytesIO(b"sqlite-transfer")
            handler.send_json = Mock()

            handler.do_POST()

            handler.central_advertiser.set_enabled.assert_called_once_with(True)
            handler.send_json.assert_called_once_with(
                200,
                {"success": True, "revision": 8, "nodeId": handler.store.node_id},
                handler.headers["Origin"],
            )
            self.assertEqual(
                list(Path(temporary_directory).glob(".cras-transfer-upload-*.sqlite3")),
                [],
            )

    def test_pwa_resources_are_served_with_service_worker_scope(self):
        handler = object.__new__(CRASRequestHandler)
        handler.path = "/sw.js"
        handler.ui_root = Path(__file__).parent
        handler.client_address = ("127.0.0.1", 12345)
        handler.headers = {}
        handler.wfile = io.BytesIO()
        handler.send_response = Mock()
        handler.send_header = Mock()
        handler.end_headers = Mock()

        handler.do_GET()

        self.assertIn(b"cras-mobile-shell-v5", handler.wfile.getvalue())
        self.assertIn(b'"/CRAS.css"', handler.wfile.getvalue())
        self.assertIn(b'"/CRAS.js"', handler.wfile.getvalue())
        handler.send_header.assert_any_call("Content-Type", "application/javascript; charset=utf-8")
        handler.send_header.assert_any_call("Service-Worker-Allowed", "/")

    def test_frontend_assets_are_served_as_static_resources(self):
        for path, content_type in (
            ("/CRAS.css", "text/css; charset=utf-8"),
            ("/CRAS.js", "application/javascript; charset=utf-8"),
        ):
            with self.subTest(path=path):
                handler = object.__new__(CRASRequestHandler)
                handler.path = path
                handler.ui_root = Path(__file__).parent
                handler.client_address = ("127.0.0.1", 12345)
                handler.headers = {}
                handler.wfile = io.BytesIO()
                handler.send_response = Mock()
                handler.send_header = Mock()
                handler.end_headers = Mock()

                handler.do_GET()

                self.assertTrue(handler.wfile.getvalue())
                handler.send_header.assert_any_call("Content-Type", content_type)

        handler = object.__new__(CRASRequestHandler)
        handler.path = "/CRAS.html"
        handler.ui_root = Path(__file__).parent
        handler.client_address = ("127.0.0.1", 12345)
        handler.headers = {}
        handler.wfile = io.BytesIO()
        handler.send_response = Mock()
        handler.send_header = Mock()
        handler.end_headers = Mock()

        handler.do_GET()

        document = handler.wfile.getvalue()
        self.assertIn(b'href="./CRAS.css"', document)
        self.assertIn(b'src="./CRAS.js"', document)

    def test_mobile_portal_serves_structured_html_and_direct_https_link(self):
        handler = object.__new__(CRASRequestHandler)
        handler.headers = {"Host": "cras-123456789abc.local:8765"}
        handler.client_address = ("192.168.1.25", 12345)
        handler.mobile_ca_fingerprint = "ab:cd"
        handler.mobile_https_ready = True
        handler.wfile = io.BytesIO()
        handler.send_response = Mock()
        handler.send_header = Mock()
        handler.end_headers = Mock()

        handler.serve_mobile_portal()

        page = handler.wfile.getvalue().decode("utf-8")
        self.assertIn("<!doctype html>", page.lower())
        self.assertIn("<style>", page)
        self.assertIn('href="http://cras-123456789abc.local:8765/api/mobile-ca"', page)
        self.assertIn('href="https://cras-123456789abc.local:8766/"', page)
        self.assertIn("Ajustes de Confiança do Certificado", page)
        self.assertIn("Adicionar à Tela de Início", page)
        self.assertNotIn(":root {", page.split("<body>", 1)[1])

    def test_mobile_portal_does_not_offer_inactive_secure_server(self):
        handler = object.__new__(CRASRequestHandler)
        handler.headers = {"Host": "cras-123456789abc.local:8765"}
        handler.client_address = ("192.168.1.25", 12345)
        handler.mobile_ca_fingerprint = ""
        handler.mobile_https_ready = False
        handler.wfile = io.BytesIO()
        handler.send_response = Mock()
        handler.send_header = Mock()
        handler.end_headers = Mock()

        handler.serve_mobile_portal()

        page = handler.wfile.getvalue().decode("utf-8")
        self.assertIn("O acesso HTTPS pelo celular não está ativo", page)
        self.assertNotIn('href="https://cras-123456789abc.local:8766/"', page)

    def test_mobile_portal_rejects_malformed_host_header(self):
        handler = object.__new__(CRASRequestHandler)
        handler.headers = {"Host": 'evil.local"><script>'}
        handler.client_address = ("192.168.1.25", 12345)
        handler.send_error = Mock()

        handler.serve_mobile_portal()

        handler.send_error.assert_called_once_with(400, "O endereço local do celular é inválido.")


if __name__ == "__main__":
    unittest.main()
