/**
 * Analyse d'un update Yjs reçu d'un client (CLAUDE.md §5, étape 2 de la boucle).
 *
 * Crédit : on compte les caractères **insérés** que le serveur n'a pas encore
 * (`diffUpdate` contre son vecteur d'état), pour qu'un client qui renvoie un
 * contenu déjà connu (resynchronisation) ne soit pas débité deux fois. Les
 * suppressions ne comptent pas.
 *
 * L'éditeur produit du texte et des marques de mise en forme (Quill : attributs
 * du Y.Text). Une marque ne compte pas de caractère ; seuls les formats de
 * `FORMATS` sont admis. Tout autre contenu (objets, images, binaires,
 * sous-documents…) contournerait le décompte ou le PDF : l'update est refusé.
 */
import { isAllowedFormat } from "@editeur/shared";
import * as Y from "yjs";

export type UpdateAnalysis =
  | { valid: true; chars: number; /** Rien de neuf : inutile d'écrire. */ empty: boolean }
  | { valid: false };

export function analyzeUpdate(update: Uint8Array, serverStateVector: Uint8Array): UpdateAnalysis {
  const fresh = Y.decodeUpdate(Y.diffUpdate(update, serverStateVector));
  let chars = 0;
  let structs = 0;
  for (const struct of fresh.structs) {
    if (struct instanceof Y.Skip) continue;
    structs++;
    if (struct instanceof Y.GC) continue;
    const content = (struct as Y.Item).content;
    if (content instanceof Y.ContentString) chars += content.str.length;
    else if (content instanceof Y.ContentFormat) {
      if (!isAllowedFormat(content.key, content.value)) return { valid: false };
    } else if (!(content instanceof Y.ContentDeleted)) return { valid: false };
  }
  // `diffUpdate` garde tout le jeu de suppressions : sans structure nouvelle ni
  // suppression, l'update n'apporte rien (premier échange d'un client neuf).
  return { valid: true, chars, empty: structs === 0 && fresh.ds.clients.size === 0 };
}
