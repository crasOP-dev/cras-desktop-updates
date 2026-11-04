import tempfile
import unittest
from pathlib import Path

from cryptography.exceptions import InvalidTag

from main import (
    PeerStore,
    RevisionConflict,
    decode_envelope,
    encode_envelope,
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
        import hashlib

        checksum = hashlib.sha256(executable).hexdigest()
        verify_update_checksum(executable, f"{checksum}  CRAS-Desktop.exe")
        with self.assertRaisesRegex(ValueError, "checksum"):
            verify_update_checksum(executable, "0" * 64)


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


if __name__ == "__main__":
    unittest.main()
