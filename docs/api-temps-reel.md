# API temps réel — WebSocket `/collab`

Ce document complète [`openapi.yaml`](openapi.yaml), qui décrit l'API HTTP. Il donne au
jury de quoi écrire son propre client d'écriture, par exemple pour vérifier qu'aucune
modification n'est perdue ou que le crédit quotidien est respecté.

## 1. En bref

| Élément | Valeur |
|---|---|
| URL | `wss://<distribution>.cloudfront.net/collab` (en local : `ws://localhost:3000/collab`) |
| Protocole | Hocuspocus 4.7.1, c'est-à-dire la synchronisation Yjs (`y-protocols` sync et awareness) avec authentification par jeton |
| Client conseillé | `@hocuspocus/provider` **4.7.1** et `yjs` 13.6 ; en Node, ajouter `ws` comme implémentation WebSocket |
| Nom du document (`name`) | le `docId` renvoyé par `POST /api/documents` |
| Jeton (`token`) | le `token` renvoyé par `POST /api/session` (valable 24 h) |
| Droit d'accès | l'adresse e-mail du jeton doit être **éditrice** du document, sinon l'authentification échoue |
| Contenu | un seul `Y.Text`, nommé **`contenu`** |
| Messages applicatifs | messages *stateless* Hocuspocus, en JSON (§4) |

## 2. Règles à connaître

1. **Accepté = confirmé.** Une modification est acceptée quand elle est écrite dans
   DynamoDB. Le serveur ne l'applique à sa copie, ne la diffuse aux autres et ne la
   confirme qu'**après** cette écriture. La confirmation est le message
   `{"type":"ack","seq":N}`, où `N` est la séquence du journal qui la contient. Une
   modification qui n'a pas reçu d'`ack` n'est pas encore acceptée.
2. **Un `ack` par message de modification.** Hocuspocus traite les messages d'une
   connexion un par un. Chaque message de modification reçoit son `ack` dans l'ordre
   d'envoi. Plusieurs frappes groupées dans un même message (option `flushDelay` du
   provider, 200 ms dans l'éditeur) reçoivent donc un seul `ack`.
3. **Écriture au même endroit.** Yjs est un CRDT : deux rédacteurs peuvent insérer à la
   même position, toutes les copies convergent vers le même texte.
4. **Crédit quotidien.** Chaque rédacteur dispose de 10 000 caractères **insérés** par jour UTC,
   tous appareils et tous documents confondus. Les suppressions, la mise en forme et la
   restauration d'une version ne consomment rien. Le crédit restant se lit avec
   `GET /api/me/credit`.
5. **Contenu autorisé.** Uniquement du texte, avec ces attributs de mise en forme :

   | Attribut | Valeurs |
   |---|---|
   | `bold`, `italic`, `underline` | `true` (ou `null` / `false` pour retirer) |
   | `font` | `"serif"` (Times) ou `"monospace"` (Courier) ; absent = sans empattement (Helvetica) |
   | `size` | `"small"`, `"large"` ou `"huge"` ; absent = normale |

   Tout autre contenu (autre type Yjs, objet, image, lien, couleur, taille libre…) est
   **refusé** avec le code 4400.
6. **Après un refus**, le serveur ferme la connexion au document. Avant toute
   reconnexion, le client **doit détruire son `Y.Doc`** et en créer un neuf : l'ancien
   contient la modification refusée, qui repartirait à la reconnexion.

## 3. Refus

Le serveur envoie d'abord un message `refus`, puis ferme la connexion au document.
Hocuspocus 4 ne transmet pas de code WebSocket propre au document (une socket peut porter
plusieurs documents). Le code se lit donc dans le message `refus`, et il est aussi repris
au début de la raison de fermeture (par exemple `"4001 credit-epuise"`).

| Code | `raison` | Cause | Ce que fait l'éditeur |
|---|---|---|---|
| 4001 | `credit-epuise` | La modification ferait dépasser 10 000 caractères aujourd'hui | Nouveau `Y.Doc`, reconnexion en **lecture seule** jusqu'à `finLe` (minuit UTC) |
| 4003 | `bloque` | 5 refus en 1 minute : rédacteur bloqué 5 h | Nouveau `Y.Doc`, **aucune reconnexion** avant `finLe` |
| 4400 | `contenu-invalide` | Contenu ou attribut non autorisé (§2.5) | Nouveau `Y.Doc`, reconnexion |
| 4500 | `erreur-serveur` | Écriture DynamoDB impossible : rien n'a été accepté | Nouveau `Y.Doc`, reconnexion |

Les refus 4001 et 4003 comptent pour le blocage. Un rédacteur bloqué peut toujours lire le
document : il reçoit les modifications des autres.

## 4. Messages *stateless* (JSON)

Envoyés avec `provider.sendStateless(JSON.stringify(message))`, reçus dans le rappel
`onStateless({ payload })`. Les types exacts sont `ServerMessage` et `ClientMessage` dans
`packages/shared/src/realtime.ts`.

**Du serveur vers le client**

| Message | Signification |
|---|---|
| `{"type":"ack","seq":42}` | Le message de modification précédent est écrit dans le journal à la séquence 42 |
| `{"type":"refus","code":4001,"raison":"credit-epuise","finLe":1793059200000}` | Refus (§3) ; `finLe` en millisecondes depuis l'époque Unix, pour 4001 et 4003 |
| `{"type":"version-enregistree","seq":42,"label":"Avant relecture"}` | Version nommée enregistrée (instantané immédiat) |
| `{"type":"restauree","seq":43}` | Version restaurée, écrite dans le journal à la séquence 43 comme une nouvelle modification |
| `{"type":"apercu","snapshotKey":"snapshots/<docId>/42.bin","delta":[{"insert":"Titre","attributes":{"bold":true}},{"insert":"\n"}]}` | Contenu d'une version, pour l'aperçu |
| `{"type":"erreur","message":"version inconnue"}` | Opération de version impossible |

**Du client vers le serveur**

| Message | Effet |
|---|---|
| `{"type":"enregistrer","label":"Avant relecture"}` | Enregistre la version actuelle (nom tronqué à 80 caractères ; vide = « Version sans nom ») |
| `{"type":"apercu","snapshotKey":"snapshots/<docId>/42.bin"}` | Demande le contenu d'une version (lecture seule) |
| `{"type":"restaurer","snapshotKey":"snapshots/<docId>/42.bin"}` | Réapplique le contenu de cette version comme une nouvelle modification, sans crédit |

Les clés `snapshotKey` viennent de `GET /api/documents/{docId}/versions`. Une clé qui
n'appartient pas au document est refusée (`erreur`).

**Présence et curseurs.** L'éditeur publie dans l'*awareness* Yjs un champ
`user = { name, email, color, colorLight }`, et y-quill y ajoute un champ `cursor`
(positions relatives Yjs). Ces données ne passent pas par le journal et ne consomment pas
de crédit.

## 5. Exemple de client minimal (Node 20)

```js
// npm install @hocuspocus/provider@4.7.1 yjs ws
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import WebSocket from "ws";
import * as Y from "yjs";

const base = "https://xxxx.cloudfront.net";
const post = async (path, body, token) =>
  (await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })).json();

const { token } = await post("/api/session", { name: "Jury", email: "jury@exemple.org" });
const { docId } = await post("/api/documents", { title: "Test du jury" }, token);

const doc = new Y.Doc();
const text = doc.getText("contenu");
const socket = new HocuspocusProviderWebsocket({ url: base.replace(/^http/, "ws") + "/collab", WebSocketPolyfill: WebSocket });
const provider = new HocuspocusProvider({
  websocketProvider: socket,
  name: docId,
  document: doc,
  token,
  onSynced: () => text.insert(0, "Bonjour"),              // une modification = un message
  onStateless: ({ payload }) => console.log(JSON.parse(payload)), // {"type":"ack","seq":1}
  onAuthenticationFailed: () => console.log("accès refusé"),
});
provider.attach(); // socket fournie par nous : le provider ne s'y attache pas tout seul
```

Pour vérifier la convergence : connecter plusieurs clients au même `docId`, les faire
écrire au même endroit, attendre que chacun ait reçu ses `ack`, puis comparer
`text.toString()` et `Y.encodeStateVector(doc)` entre les clients.

## 6. Clients et tests fournis

| Fichier ou commande | Rôle |
|---|---|
| `tests/helpers/realtime.ts` (`TestWriter`) | Client de test complet : rattache chaque frappe à son `ack`, mesure le retard de confirmation, garde le refus et la raison de fermeture |
| `npm run test:c2 -- --base-url https://xxxx.cloudfront.net --bucket <BucketName>` | 20 clients écrivent au même endroit à 8 caractères/s ; vérifie la convergence et que chaque `seq` confirmé est en base |
| `npm run test:c4 -- --base-url https://xxxx.cloudfront.net --bucket <BucketName>` | Un même e-mail sur 3 appareils et 2 documents : jamais plus de 10 000 caractères acceptés |
| `packages/realtime/test/*.test.ts` | Tests Vitest du protocole : refus, formats, versions, resynchronisation |

`<BucketName>` est la sortie `BucketName` de la stack `EditeurPartage` (voir le README).
L'option `--bucket` sert à relire l'état depuis la base (instantané S3 et journal
DynamoDB) ; elle demande des identifiants AWS en lecture.
