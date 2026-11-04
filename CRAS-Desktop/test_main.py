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

    def test_merges_and_resolves_concurrent_peer_changes(self):
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
        self.assertEqual(self.store.sync("peer-b", "request-3", peer_b, {})["status"], "ok")

        peer_a = {
            "appointments": [{"id": "appointment-1", "nome": "Alteração A"}],
            "paaRecords": [],
            "settings": {},
        }
        conflict = self.store.sync("peer-a", "request-4", peer_a, {})
        self.assertEqual(conflict["status"], "conflicts")
        self.assertEqual(conflict["conflicts"][0]["key"], "appointments:appointment-1")

        resolved = self.store.sync(
            "peer-a",
            "request-5",
            peer_a,
            {"appointments:appointment-1": "local"},
        )
        self.assertEqual(resolved["status"], "ok")
        self.assertEqual(resolved["snapshot"]["appointments"][0]["nome"], "Alteração A")

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
