#!/usr/bin/env bash
# Déploie l'éditeur partagé dans eu-north-1 (stack EditeurPartage).
#
#   scripts/deploy.sh                          # déploiement ou mise à jour
#   SES_SENDER=moi@exemple.org scripts/deploy.sh   # + e-mail au créateur d'un lien
#
# Prérequis : AWS CLI v2 configurée (utilisateur IAM, jamais le compte root), Node 20,
# npm. Le script est idempotent : il peut être relancé pour une mise à jour.
#   1. crée les secrets applicatifs dans SSM (SecureString) s'ils n'existent pas ;
#   2. retrouve la liste de préfixes gérée de CloudFront (seule origine admise par l'ALB) ;
#   3. installe, compile (bundles esbuild + front), amorce CDK si besoin, déploie.
# Aucune clé ni aucun secret n'est écrit dans le dépôt ni affiché.
set -euo pipefail

REGION="eu-north-1"
TAG_KEY="projet"
TAG_VALUE="editeur-partage"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

for tool in aws node npm openssl; do
  command -v "$tool" >/dev/null || { echo "outil manquant : $tool" >&2; exit 1; }
done
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || { echo "Node 20 ou plus requis" >&2; exit 1; }

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
CALLER="$(aws sts get-caller-identity --query Arn --output text)"
case "$CALLER" in *":root") echo "Refus : n'utilisez pas le compte root, mais un utilisateur IAM." >&2; exit 1 ;; esac
echo "Compte $ACCOUNT, identité $CALLER, région $REGION"

# --- 1. Secrets applicatifs (SSM SecureString) : générés ici, jamais affichés.
create_secret() {
  local name="$1"
  if aws ssm get-parameter --region "$REGION" --name "$name" >/dev/null 2>&1; then
    echo "secret $name : déjà présent"
    return
  fi
  local file
  file="$(mktemp)"
  chmod 600 "$file"
  openssl rand -base64 48 | tr -d '\n' >"$file"
  aws ssm put-parameter --region "$REGION" --name "$name" --type SecureString \
    --value "file://$file" --tags "Key=$TAG_KEY,Value=$TAG_VALUE" >/dev/null
  rm -f "$file"
  echo "secret $name : créé"
}
create_secret /editeur/hmac-secret
create_secret /editeur/admin-token

# --- 2. Liste de préfixes gérée de CloudFront (dépend de la région).
PREFIX_LIST="$(aws ec2 describe-managed-prefix-lists --region "$REGION" \
  --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing \
  --query 'PrefixLists[0].PrefixListId' --output text)"
[ -n "$PREFIX_LIST" ] && [ "$PREFIX_LIST" != "None" ] || { echo "liste de préfixes CloudFront introuvable" >&2; exit 1; }
echo "liste de préfixes CloudFront : $PREFIX_LIST"

# --- 3. Installation, compilation, déploiement.
npm ci --no-audit --no-fund
npm run build

if ! aws cloudformation describe-stacks --region "$REGION" --stack-name CDKToolkit >/dev/null 2>&1; then
  (cd infra && npx cdk bootstrap "aws://$ACCOUNT/$REGION" --tags "$TAG_KEY=$TAG_VALUE")
fi

CONTEXT=()
if [ -n "${SES_SENDER:-}" ]; then
  CONTEXT=(-c "sesSender=$SES_SENDER")
  echo "expéditeur SES : $SES_SENDER (cliquez le lien de vérification reçu par e-mail ; en bac à sable, les destinataires doivent aussi être vérifiés)"
fi

(cd infra && npx cdk deploy EditeurPartage --require-approval never \
  --parameters "CloudFrontPrefixListId=$PREFIX_LIST" ${CONTEXT[@]+"${CONTEXT[@]}"})

URL="$(aws cloudformation describe-stacks --region "$REGION" --stack-name EditeurPartage \
  --query "Stacks[0].Outputs[?OutputKey=='Url'].OutputValue" --output text)"
cat <<EOF

Déploiement terminé.
  Application        : $URL
  Tableau de bord    : $URL/admin
  Jeton admin        : aws ssm get-parameter --region $REGION --name /editeur/admin-token --with-decryption --query Parameter.Value --output text
  Les instances démarrent en 2 à 4 minutes après la fin du déploiement (contrôle : $URL/sante).
EOF
