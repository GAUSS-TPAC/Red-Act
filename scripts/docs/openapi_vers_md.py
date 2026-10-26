#!/usr/bin/env python3
"""Transforme docs/openapi.yaml en un document Markdown lisible (pour le PDF de l'API).

    python3 scripts/docs/openapi_vers_md.py docs/openapi.yaml > api-http.md

openapi.yaml reste la source de vérité ; ce document n'est qu'une mise en page.
"""
import json
import sys

import yaml

METHODS = ["get", "post", "put", "patch", "delete"]


def load(path):
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f)


def resolve(spec, node):
    """Suit les $ref locaux (#/components/...)."""
    while isinstance(node, dict) and "$ref" in node:
        target = spec
        for part in node["$ref"].lstrip("#/").split("/"):
            target = target[part]
        node = target
    return node


def type_of(spec, schema):
    schema = resolve(spec, schema or {})
    t = schema.get("type", "objet")
    if t == "array":
        return f"liste de {type_of(spec, schema.get('items'))}"
    if "enum" in schema:
        return " \\| ".join(f"`{v}`" for v in schema["enum"])
    fmt = schema.get("format")
    names = {"string": "texte", "integer": "entier", "number": "nombre", "boolean": "booléen", "object": "objet"}
    label = names.get(t, t)
    if fmt == "uuid":
        label += " (UUID)"
    elif fmt == "date-time":
        label += " (date ISO 8601)"
    elif fmt == "uri":
        label += " (URL)"
    return label


def constraints(schema):
    parts = []
    for key, label in (("minLength", "≥ {} car."), ("maxLength", "≤ {} car."), ("minimum", "≥ {}"), ("maximum", "≤ {}")):
        if key in schema:
            parts.append(label.format(schema[key]))
    if schema.get("nullable"):
        parts.append("peut être null")
    return ", ".join(parts)


def esc(text):
    return str(text).replace("|", "\\|").replace("\n", " ").strip()


def fields_table(spec, schema, out, indent=""):
    schema = resolve(spec, schema or {})
    props = schema.get("properties")
    if not props:
        return False
    required = set(schema.get("required", []))
    out.append("| Champ | Type | Obligatoire | Contraintes et description |")
    out.append("|---|---|---|---|")
    for name, prop in props.items():
        prop_r = resolve(spec, prop)
        desc = " — ".join(x for x in (constraints(prop_r), esc(prop_r.get("description", ""))) if x)
        out.append(f"| `{indent}{name}` | {type_of(spec, prop)} | {'oui' if name in required else 'non'} | {desc} |")
        items = resolve(spec, prop_r.get("items", {})) if prop_r.get("type") == "array" else None
        if items and items.get("properties"):
            for sub, subprop in items["properties"].items():
                sp = resolve(spec, subprop)
                d = " — ".join(x for x in (constraints(sp), esc(sp.get("description", ""))) if x)
                out.append(f"| `{indent}{name}[].{sub}` | {type_of(spec, subprop)} | — | {d} |")
    return True


def example_of(content):
    if "example" in content:
        return content["example"]
    schema = content.get("schema", {})
    return schema.get("example")


def main(path):
    spec = load(path)
    info = spec["info"]
    out = [f"# {info['title']}", "", f"Version {info['version']} — source : `docs/openapi.yaml` (OpenAPI {spec['openapi']}).", ""]
    out += [info.get("description", "").strip(), ""]

    out += ["## Serveurs", ""]
    for server in spec.get("servers", []):
        out.append(f"- `{server['url']}` — {server.get('description', 'déploiement AWS (domaine CloudFront affiché par scripts/deploy.sh)')}")
    out.append("")

    schemes = spec.get("components", {}).get("securitySchemes", {})
    out += ["## Authentification", "", "| Nom | Mécanisme | Description |", "|---|---|---|"]
    for name, sch in schemes.items():
        how = f"en-tête `Authorization: Bearer <jeton>`" if sch.get("scheme") == "bearer" else f"en-tête `{sch.get('name')}`"
        out.append(f"| `{name}` | {how} | {esc(sch.get('description', ''))} |")
    out.append("")

    # Récapitulatif des routes.
    out += ["## Récapitulatif des routes", "", "| Méthode | Chemin | Rôle | Authentification |", "|---|---|---|---|"]
    for route, item in spec["paths"].items():
        for method in METHODS:
            if method in item:
                op = item[method]
                auth = ", ".join(next(iter(s)) for s in op.get("security", [])) or "aucune"
                out.append(f"| `{method.upper()}` | `{route}` | {esc(op.get('summary', ''))} | {auth} |")
    out.append("")

    # Détail, groupé par étiquette.
    # Ordre de lecture : du premier appel (session) au téléchargement, puis l'admin.
    tags = ["santé", "session", "documents", "liens", "admin"]
    titles = {"santé": "Santé", "session": "Session et crédit", "documents": "Documents", "liens": "Liens et téléchargement", "admin": "Tableau de bord (admin)"}
    for tag in tags:
        ops = [(r, m, i[m]) for r, i in spec["paths"].items() for m in METHODS if m in i and tag in i[m].get("tags", [])]
        if not ops:
            continue
        out += [f"## {titles.get(tag, tag.capitalize())}", ""]
        for route, method, op in ops:
            out += [f"### `{method.upper()} {route}`", "", f"**{op.get('summary', '')}**", ""]
            if op.get("description"):
                out += [op["description"].strip(), ""]
            security = op.get("security", [])
            out += [f"*Authentification :* {', '.join('`' + next(iter(s)) + '`' for s in security) if security else 'aucune'}.", ""]

            params = op.get("parameters", [])
            if params:
                out += ["**Paramètres**", "", "| Nom | Où | Obligatoire | Type | Description |", "|---|---|---|---|---|"]
                for p in params:
                    p = resolve(spec, p)
                    where = {"path": "chemin", "query": "requête", "cookie": "cookie", "header": "en-tête"}.get(p["in"], p["in"])
                    out.append(f"| `{p['name']}` | {where} | {'oui' if p.get('required') else 'non'} | {type_of(spec, p.get('schema'))} | {esc(p.get('description', ''))} |")
                out.append("")

            body = op.get("requestBody")
            if body:
                content = body["content"]["application/json"]
                out += ["**Corps de la requête** (`application/json`)", ""]
                fields_table(spec, content.get("schema"), out)
                out.append("")
                ex = example_of(content)
                if ex is not None:
                    out += ["Exemple :", "", "```json", json.dumps(ex, ensure_ascii=False, indent=2), "```", ""]

            out += ["**Réponses**", "", "| Code | Signification |", "|---|---|"]
            for code, resp in op.get("responses", {}).items():
                resp = resolve(spec, resp)
                out.append(f"| **{code}** | {esc(resp.get('description', ''))} |")
            out.append("")
            for code, resp in op.get("responses", {}).items():
                resp = resolve(spec, resp)
                headers = resp.get("headers", {})
                content = resp.get("content", {}).get("application/json")
                if not headers and not content:
                    continue
                out += [f"*Réponse {code}*", ""]
                if headers:
                    for name, h in headers.items():
                        h = resolve(spec, h)
                        desc = esc(h.get("description", "")) or type_of(spec, h.get("schema"))
                        out.append(f"- en-tête `{name}` : {desc}")
                    out.append("")
                if content:
                    if fields_table(spec, content.get("schema"), out):
                        out.append("")
                    ex = example_of(content)
                    if ex is not None:
                        out += ["```json", json.dumps(ex, ensure_ascii=False, indent=2), "```", ""]

            # Exemple d'appel.
            url = "https://xxxx.cloudfront.net" + route.replace("{docId}", "<docId>").replace("{linkId}", "<linkId>")
            curl = [f"curl -i -X {method.upper()} '{url}'"]
            if any(next(iter(s)) == "session" for s in security):
                curl.append("  -H 'Authorization: Bearer <jeton>'")
            if any(next(iter(s)) == "admin" for s in security):
                curl.append("  -H 'x-admin-token: <jeton admin>'")
            if body:
                ex = example_of(body["content"]["application/json"]) or {}
                curl.append("  -H 'content-type: application/json'")
                curl.append(f"  -d '{json.dumps(ex, ensure_ascii=False)}'")
            if route.endswith("/claim"):
                curl.append("  -b cookies.txt -c cookies.txt   # garde et renvoie le cookie ticket")
            out += ["Exemple d'appel :", "", "```bash", " \\\n".join(curl), "```", ""]

    # Schémas communs.
    out += ["## Schémas communs", ""]
    for name, schema in spec.get("components", {}).get("schemas", {}).items():
        out += [f"### `{name}`", ""]
        if not fields_table(spec, schema, out):
            out.append(f"{type_of(spec, schema)}" + (f", motif `{schema['pattern']}`" if "pattern" in schema else ""))
        out.append("")

    print("\n".join(out))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "docs/openapi.yaml")
