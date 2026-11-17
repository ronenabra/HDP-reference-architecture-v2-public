"""Unit tests for candidate contract validation, including decoded content."""
import importlib.util
import json
from pathlib import Path
import unittest
import tempfile

spec = importlib.util.spec_from_file_location(
    "candidate", Path(__file__).with_name("validate-public-contracts.py"))
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)


class CandidateValidationTests(unittest.TestCase):
    """Exercise schema/reference and decoded-JSON failure modes."""

    def test_duplicate_json_members(self):
        """Escaped names must not evade duplicate detection."""
        for value in ['{"x":1,"x":2}', '{"x":1,"\\u0078":2}', '[{"x":{"v":1,"v":2}}]']:
            with self.assertRaises(candidate.CandidateError):
                candidate.decoded_json(value)
        self.assertEqual(candidate.decoded_json('{"a":{"x":1},"b":{"x":2}}'),
                         {"a": {"x": 1}, "b": {"x": 2}})

    def test_closed_31_schema(self):
        """Draft 2020-12 const/contains constraints apply to media examples."""
        document = {"content": {"schema": {"type": "array", "contains": {"const": "x"},
                                          "minContains": 1, "maxContains": 1},
                                "example": ["x", "y"]}}
        self.assertEqual(candidate.validate_examples(document)["mediaExamples"], 1)
        document["content"]["example"] = ["x", "x"]
        with self.assertRaises(candidate.CandidateError):
            candidate.validate_examples(document)

    def test_reference_cycles_and_external_examples(self):
        """Untrusted references cannot fetch remote data or recurse forever."""
        document = {"a": {"$ref": "#/b"}, "b": {"$ref": "#/a"}}
        with self.assertRaises(candidate.CandidateError):
            candidate.resolve(document, document["a"])
        with self.assertRaises(candidate.CandidateError):
            candidate.resolve({}, {"$ref": "https://example.org/private"})
        self.assertEqual(candidate.resolve({"a/b": 1}, {"$ref": "#/a~1b"}), 1)

    def test_changed_existing_schema_inventory(self):
        """Report changed schemas as well as additions and removals."""
        before = {"components": {"schemas": {"old": {}, "changed": {"const": 1}, "same": {}}}}
        after = {"components": {"schemas": {"new": {}, "changed": {"const": 2}, "same": {}}}}
        self.assertEqual(candidate.schema_changes(before, after),
                         {"added": ["new"], "removed": ["old"], "changed": ["changed"]})

    def test_example_payload_inventory_detects_same_name_changes(self):
        """Example names alone must not hide changed assertion or RAR payloads."""
        before = {"paths": {"/authorize": {"post": {"requestBody": {"example": {"scope": "a"}}}}}}
        after = json.loads(json.dumps(before))
        after["paths"]["/authorize"]["post"]["requestBody"]["example"]["scope"] = "b"
        self.assertNotEqual(candidate.semantic_inventory(before), candidate.semantic_inventory(after))

    def test_assertion_header_uses_authoritative_31_constraints(self):
        """ES384/thumbprint kid are accepted while unknown members and algorithms fail."""
        document = {"components": {"schemas": {"ClientAssertionHeader": {
            "type": "object", "additionalProperties": False, "required": ["alg", "typ"],
            "properties": {"alg": {"enum": ["ES256", "ES384"]}, "typ": {"const": "JWT"},
                           "kid": {"type": "string", "pattern": "^[A-Za-z0-9_-]{43}$"}}}}}}
        schema = {"$ref": "#/components/schemas/ClientAssertionHeader"}
        candidate.validate_schema(document, schema, {"alg": "ES384", "typ": "JWT", "kid": "a" * 43})
        for value in [{"alg": "RS256", "typ": "JWT"}, {"alg": "ES256", "typ": "JWT", "kid": "legacy"},
                      {"alg": "ES384", "typ": "JWT", "jku": "https://untrusted.example"}]:
            with self.assertRaises(candidate.jsonschema.ValidationError):
                candidate.validate_schema(document, schema, value)

    def test_generated_references_require_pinned_dependency_resolution(self):
        """A missing generated binding is an explicit error, never a network lookup."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "fhir/resources").mkdir(parents=True)
            (root / "cache/example/package").mkdir(parents=True)
            resource = root / "fhir/resources/profile.json"
            resource.write_text(json.dumps({"resourceType": "StructureDefinition", "url": "urn:profile",
                                            "baseDefinition": "http://example.org/base"}))
            with self.assertRaises(candidate.CandidateError):
                candidate.validate_fhir_references(root, root / "cache")
            (root / "cache/example/package/base.json").write_text(json.dumps({"url": "http://example.org/base"}))
            self.assertEqual(candidate.validate_fhir_references(root, root / "cache")["canonicalReferences"], 1)


if __name__ == "__main__":
    unittest.main()
