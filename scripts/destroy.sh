#!/usr/bin/env bash
# Supprime TOUT ce que le projet a créé dans eu-north-1 (irréversible : documents,
# journal, PDF, versions).
#
#   scripts/destroy.sh            # demande confirmation
#   scripts/destroy.sh --yes      # sans confirmation
#   scripts/destroy.sh --yes --keep-secrets   # garde les secrets SSM (redéploiement)
#
# Ordre :
#   1. stack de test de charge (si elle existe) : bucket de résultats vidé, puis destroy ;
#   2. bucket versionné de l'application vidé de TOUTES ses versions et marqueurs de
#      suppression (sans cela, CloudFormation ne peut pas le supprimer), puis destroy ;
#   3. secrets SSM créés par deploy.sh ;
#   4. contrôle : liste des ressources encore étiquetées projet=editeur-partage.
# La stack CDKToolkit (amorçage CDK, partagée par tous les projets CDK du compte) est
# conservée ; voir le README pour la supprimer aussi.
set -euo pipefail

REGION="eu-north-1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

YES=0
KEEP_SECRETS=0
for arg in "$@"; do
  case "$arg" in
    --yes) YES=1 ;;
    --keep-secrets) KEEP_SECRETS=1 ;;
    *) echo "option inconnue : $arg" >&2; exit 2 ;;
  esac
done

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
if [ "$YES" -ne 1 ]; then
  read -r -p "Supprimer définitivement l'éditeur partagé du compte $ACCOUNT ($REGION) ? Tapez « supprimer » : " answer
  [ "$answer" = "supprimer" ] || { echo "Abandon."; exit 1; }
fi

stack_exists() {
  aws cloudformation describe-stacks --region "$REGION" --stack-name "$1" >/dev/null 2>&1
}

output_of() {
  aws cloudformation describe-stacks --region "$REGION" --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text
}

# Vide un bucket, versions et marqueurs de suppression compris (SDK du dépôt).
empty_bucket() {
  local bucket="$1"
  [ -n "$bucket" ] && [ "$bucket" != "None" ] || return 0
  echo "vidage du bucket $bucket (toutes versions)…"
  BUCKET="$bucket" REGION="$REGION" node --input-type=module -e '
    import { S3Client, ListObjectVersionsCommand, DeleteObjectsCommand } from "@aws-sdk/client-s3";
    const s3 = new S3Client({ region: process.env.REGION });
    const Bucket = process.env.BUCKET;
    let total = 0, KeyMarker, VersionIdMarker;
    do {
      const page = await s3.send(new ListObjectVersionsCommand({ Bucket, KeyMarker, VersionIdMarker, MaxKeys: 1000 }));
      const Objects = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])].map(({ Key, VersionId }) => ({ Key, VersionId }));
      if (Objects.length) {
        const result = await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects, Quiet: true } }));
        if (result.Errors?.length) throw new Error(`suppression refusée : ${JSON.stringify(result.Errors.slice(0, 3))}`);
        total += Objects.length;
      }
      ({ NextKeyMarker: KeyMarker, NextVersionIdMarker: VersionIdMarker } = page);
      if (!page.IsTruncated) break;
    } while (true);
    console.log(`  ${total} objet(s) ou version(s) supprimé(s)`);
  ' || {
    # Rien à vider si le bucket a déjà disparu.
    aws s3api head-bucket --bucket "$bucket" >/dev/null 2>&1 && return 1 || return 0
  }
}

# --- 1. Stack de test de charge.
if stack_exists EditeurPartageCharge; then
  empty_bucket "$(output_of EditeurPartageCharge ResultsBucket)"
  (cd infra && npx cdk destroy EditeurPartageCharge --force)
fi

# --- 2. Application.
if stack_exists EditeurPartage; then
  empty_bucket "$(output_of EditeurPartage BucketName)"
  (cd infra && npx cdk destroy EditeurPartage --force)
else
  echo "stack EditeurPartage absente"
fi

# --- 3. Secrets.
if [ "$KEEP_SECRETS" -ne 1 ]; then
  for name in /editeur/hmac-secret /editeur/admin-token; do
    aws ssm delete-parameter --region "$REGION" --name "$name" >/dev/null 2>&1 && echo "secret $name supprimé" || true
  done
fi

# --- 4. Contrôle (l'index des étiquettes peut garder quelques minutes des ressources supprimées).
echo "Ressources encore étiquetées projet=editeur-partage :"
aws resourcegroupstaggingapi get-resources --region "$REGION" \
  --tag-filters Key=projet,Values=editeur-partage \
  --query 'ResourceTagMappingList[].ResourceARN' --output text | tr '\t' '\n' | sed 's/^/  /'
echo "Suppression terminée."
