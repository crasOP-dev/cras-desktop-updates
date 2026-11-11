import hashlib
import json
import tempfile
import unittest
from unittest.mock import Mock, patch
from pathlib import Path

import truststore
from cryptography import x509
from cryptography.exceptions import InvalidTag

from main import (
    PeerStore,
    RevisionConflict,
    decode_envelope,
    decode_mobile_payload,
    download_update,
    encode_envelope,
    encode_mobile_payload,
    ensure_mobile_tls_certificates,
    launch_update_helper,
    lan_addresses,
    latest_release,
    verify_update_checksum,
    version_tuple,
)


class VersionTests(unittest.TestCase):
    def test_parses_release_versions(self):
        self.assertEqual(version_tuple("v1.2.3"), (1, 2, 3))
        self.assertEqual(version_tuple("1.2.3"), (1, 2, 3))

    def test_rejects_non_semver_release_tags(self):
        with self.assertRaises(ValueError):
            version_tuple("latest")

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
            self.assertIn("A versão anterior foi restaurada.", script)
            self.assertIn(str(directory / "update.log"), script)
            self.assertEqual(mocked_popen.call_args.args[0][-1], str(script_path))

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
        with patch("main.socket.socket") as socket_factory, patch(
            "main.socket.getaddrinfo", return_value=address_lookup
        ), patch(
            "main.socket.gethostbyname_ex",
            return_value=("cras-host", [], ["10.0.0.9", "192.168.1.25"]),
        ):
            socket_factory.return_value.__enter__.return_value = probe
            self.assertEqual(lan_addresses(), ["192.168.1.25", "10.0.0.9"])

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
            )
            ca_cert = x509.load_pem_x509_certificate(ca_path.read_bytes())
            server_cert = x509.load_pem_x509_certificate(server_path.read_bytes())
            names = server_cert.extensions.get_extension_for_class(
                x509.SubjectAlternativeName
            ).value
            self.assertIn("192.168.1.25", [str(value) for value in names.get_values_for_type(x509.IPAddress)])
            self.assertTrue(fingerprint)
            self.assertTrue(key_path.exists())

            second_ca_path, _, _, second_fingerprint = ensure_mobile_tls_certificates(
                directory,
                ["192.168.1.25"],
            )
            self.assertEqual(second_ca_path.read_bytes(), ca_path.read_bytes())
            self.assertEqual(second_fingerprint, fingerprint)
            self.assertEqual(server_cert.issuer, ca_cert.subject)
            ca_ski = ca_cert.extensions.get_extension_for_class(x509.SubjectKeyIdentifier).value
            server_aki = server_cert.extensions.get_extension_for_class(x509.AuthorityKeyIdentifier).value
            server_ski = server_cert.extensions.get_extension_for_class(x509.SubjectKeyIdentifier).value
            self.assertEqual(server_aki.key_identifier, ca_ski.digest)
            self.assertTrue(server_ski.digest)


if __name__ == "__main__":
    unittest.main()
