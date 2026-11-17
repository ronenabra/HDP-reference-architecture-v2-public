#!/usr/bin/env python3
"""Validate prepared public OpenAPI inputs without changing runtime contracts.

Requires PyYAML and jsonschema with Draft 2020-12 support. This is an optional
contract-analysis tool, not a runtime/startup dependency. Exit nonzero for invalid
references, examples, decoded assertion claims, or decoded RAR examples.
"""
import argparse
import base64
import hashlib
import json
from pathlib import Path

import jsonschema
import yaml


class CandidateError(ValueError):
    """The candidate contains an invalid or unresolved contract artifact."""


def resolve(document, value):
    """Resolve a local JSON pointer, rejecting circular or external examples."""
    seen = set()
    while isinstance(value, dict) and "$ref" in value:
        reference = value["$ref"]
        if reference in seen or not reference.startswith("#/"):
            raise CandidateError(f"Unsupported or cyclic example reference: {reference}")
        seen.add(reference)
        value = document
        for part in reference[2:].split("/"):
            value = value[part.replace("~1", "/").replace("~0", "~")]
    return value


def validate_schema(document, schema, value):
    """Validate against an OpenAPI 3.1 schema with its component definitions."""
    validator = jsonschema.Draft202012Validator(
        dict(schema, components=document.get("components", {})),
        format_checker=jsonschema.FormatChecker(),
    )
    validator.validate(value)


def decoded_json(value):
    """Decode JSON while rejecting duplicate member names at any depth."""
    def members(pairs):
        result = {}
        for key, item in pairs:
            if key in result:
                raise CandidateError(f"Duplicate JSON member: {key}")
            result[key] = item
        return result
    return json.loads(value, object_pairs_hook=members)


def check_payload(document, value, counts):
    """Check decoded token-request examples beyond contentSchema annotations."""
    if not isinstance(value, dict):
        return
    if "client_assertion" in value:
        compact = value["client_assertion"].split(".")
        if len(compact) != 3:
            raise CandidateError("Example assertion is not a compact JWT")
        def decode(part):
            return decoded_json(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
        header, claims = decode(compact[0]), decode(compact[1])
        if "ClientAssertionHeader" in document.get("components", {}).get("schemas", {}):
            validate_schema(document, {"$ref": "#/components/schemas/ClientAssertionHeader"}, header)
        elif header != {"alg": "ES256", "typ": "JWT"}:
            raise CandidateError("Example assertion header is not the closed ES256 profile")
        validate_schema(document, {"$ref": "#/components/schemas/ClientAssertionClaims"}, claims)
        if claims["iss"] != claims["sub"] or not 0 < claims["exp"] - claims["iat"] <= 300:
            raise CandidateError("Example assertion identity/lifetime mismatch")
        bases = ("https://pcm2m.health.gov.il/api/fhir-service/r4",
                 "https://pcm2mtest.health.gov.il/api/fhir-service/r4")
        if claims["aud"] not in [base + suffix for base in bases for suffix in ("/token", "/introspect")]:
            raise CandidateError("Example assertion audience is not a declared endpoint")
        counts["decodedAssertions"] += 1
    if isinstance(value.get("authorization_details"), str):
        schema = document["components"]["schemas"]["AuthorizationDetailsFormValue"]["contentSchema"]
        validate_schema(document, schema, decoded_json(value["authorization_details"]))
        counts["decodedAuthorizationDetails"] += 1


def validate_examples(document):
    """Check all media examples, including schemas that use nested references."""
    counts = {"mediaExamples": 0, "decodedAssertions": 0, "decodedAuthorizationDetails": 0}
    def walk(node):
        if isinstance(node, dict):
            if "schema" in node:
                examples = node.get("examples", {})
                if "example" in node:
                    examples = dict(examples, inline={"value": node["example"]})
                for name, example in examples.items():
                    example = resolve(document, example)
                    if "value" not in example:
                        continue
                    try:
                        validate_schema(document, node["schema"], example["value"])
                        check_payload(document, example["value"], counts)
                    except (ValueError, jsonschema.ValidationError) as error:
                        raise CandidateError(f"Example {name}: {error}") from error
                    counts["mediaExamples"] += 1
            for item in node.values():
                walk(item)
        elif isinstance(node, list):
            for item in node:
                walk(item)
    walk(document)
    return counts


def semantic_inventory(document):
    """Hash complete operation/example payloads so name reuse cannot conceal drift."""
    operations = {}
    examples = {}
    def digest(value):
        return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    def walk(node, location=""):
        if isinstance(node, dict):
            for key, value in node.items():
                if key in ("example", "examples"):
                    examples[location + "/" + key] = digest(value)
                walk(value, location + "/" + key)
        elif isinstance(node, list):
            for index, value in enumerate(node):
                walk(value, location + "/" + str(index))
    for route, item in document.get("paths", {}).items():
        for method, value in item.items():
            if method in ("get", "head", "post", "put", "patch", "delete"):
                operations[method.upper() + " " + route] = digest(value)
    walk(document)
    return {"operations": operations, "examplePayloads": examples}


def schema_changes(baseline, candidate):
    """Enumerate additions, removals and changed existing schemas by content."""
    before = baseline["components"]["schemas"]
    after = candidate["components"]["schemas"]
    return {"added": sorted(after.keys() - before.keys()),
            "removed": sorted(before.keys() - after.keys()),
            "changed": sorted(key for key in before.keys() & after.keys() if before[key] != after[key])}


def validate_candidate(root, baseline=None):
    """Return candidate inventories after checking references and all examples."""
    documents = {name: yaml.safe_load((root / name).read_text())
                 for name in ("openapi.yaml", "openapi-fhir.yaml", "openapi-oauth.yaml")}
    # Resolve references against only the three reviewed entry points. No remote fetches.
    def references(node, filename):
        if isinstance(node, dict):
            if "$ref" in node:
                target, separator, pointer = node["$ref"].partition("#")
                if target.startswith("./"):
                    target = target[2:]
                if not separator or (target and target not in documents):
                    raise CandidateError(f"Unreviewed reference: {node['$ref']}")
                resolve(documents[target or filename], {"$ref": "#" + pointer})
            for value in node.values():
                references(value, filename)
        elif isinstance(node, list):
            for value in node:
                references(value, filename)
    result = {"release": documents["openapi.yaml"]["info"]["version"], "files": {}}
    for name, document in documents.items():
        references(document, name)
        entry = {"sha256": hashlib.sha256((root / name).read_bytes()).hexdigest(),
                 "paths": len(document["paths"]),
                 "operations": sum(method in ("get", "head", "post", "put", "patch", "delete")
                                   for item in document["paths"].values() for method in item),
                 **validate_examples(document), "semanticInventory": semantic_inventory(document)}
        if name != "openapi.yaml" and baseline is not None:
            previous = yaml.safe_load((baseline / name).read_text())
            entry["schemas"] = len(document["components"]["schemas"])
            entry["schemaChanges"] = schema_changes(previous, document)
        result["files"][name] = entry
    return result


def validate_fhir_references(root, package_cache):
    """Resolve supplied canonical references against an explicit local package cache."""
    resources = list((root / "fhir/resources").glob("*.json"))
    packages = list(package_cache.glob("*/package/*.json"))
    canonicals = set()
    for filename in resources + packages:
        value = json.loads(filename.read_text())
        if value.get("url"):
            canonicals.add(value["url"])
    checked = 0
    unresolved = []
    def walk(node, filename):
        nonlocal checked
        if isinstance(node, dict):
            for key, value in node.items():
                if key in ("baseDefinition", "valueSet", "targetProfile", "profile"):
                    for reference in value if isinstance(value, list) else [value]:
                        if isinstance(reference, str) and reference.startswith("http"):
                            checked += 1
                            if reference.split("|")[0].split("#")[0] not in canonicals:
                                unresolved.append({"file": filename.name, "reference": reference})
                walk(value, filename)
        elif isinstance(node, list):
            for value in node:
                walk(value, filename)
    for filename in resources:
        walk(json.loads(filename.read_text()), filename)
    if unresolved:
        raise CandidateError(f"Unresolved generated references: {unresolved}")
    return {"resources": len(resources), "packageFiles": len(packages),
            "canonicalReferences": checked, "unresolved": unresolved}



def main():
    """Validate explicit prepared inputs; never assume a private checkout or developer cache."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--spec-root", type=Path,
                        default=Path(__file__).resolve().parent.parent / "docs")
    parser.add_argument("--compare", type=Path)
    parser.add_argument("--fhir-resources", type=Path,
                        help="Optional explicit root containing fhir/resources")
    parser.add_argument("--package-cache", type=Path,
                        help="Explicit independently prepared FHIR package cache for optional reference checks")
    args = parser.parse_args()
    if bool(args.fhir_resources) != bool(args.package_cache):
        parser.error("--fhir-resources and --package-cache must be supplied together")
    result = validate_candidate(args.spec_root, args.compare)
    if args.fhir_resources:
        result["fhirReferences"] = validate_fhir_references(args.fhir_resources, args.package_cache)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
