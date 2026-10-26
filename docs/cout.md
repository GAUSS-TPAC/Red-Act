# Coût — Éditeur de documents partagé

Compte AWS en plan gratuit avec 100 $ de crédits, région eu-north-1. Ce document donne
(1) les choix faits pour le coût, (2) une estimation par poste, (3) la preuve relevée dans
la facturation AWS, (4) la façon de la vérifier.

> Les prix unitaires ci-dessous sont les prix publics approximatifs d'eu-north-1 relevés
> pendant le projet ; ils servent à l'estimation. La **preuve** est le relevé de la
> facturation (§3), qui fait foi.

## 1. Choix guidés par le coût

| Choix | Économie |
|---|---|
| Pas de NAT Gateway (sous-réseaux publics, groupes de sécurité fermés, points de terminaison *gateway* S3 et DynamoDB gratuits) | ≈ 35 $/mois + trafic |
| Pas de Redis (un seul serveur temps réel, autorité unique) | ≈ 12 à 25 $/mois |
| Un seul serveur temps réel t3.small, API en t3.micro (niveau gratuit), 1 instance API hors pic | — |
| Montée à 4 instances API **seulement** autour d'un `opensAt` (actions programmées), retour à 1 après 15 min | ≈ 3 instances × 25 min par pic au lieu de 24 h/24 |
| DynamoDB à la demande : rien au repos ; group commit (une transaction par document au plus toutes les 100 ms, quel que soit le nombre de rédacteurs) | écritures divisées par le nombre de frappes regroupées |
| 410 servi depuis la mémoire de l'instance (annonce de l'épuisement) : aucune lecture DynamoDB pour les ≈ 10 000 visiteurs refusés d'un pic | — |
| PDF supprimés après 1 jour, versions S3 non courantes après 30 jours, journal DynamoDB expiré après 7 jours (TTL), journaux CloudWatch gardés 7 jours | stockage borné |
| CloudFront avec son certificat par défaut : ni domaine ni ACM | ≈ 12 $/an |
| Instance de test de charge créée pour le test puis détruite (`EditeurPartageCharge`) | payée à l'heure d'usage seulement |

## 2. Estimation

### 2.1 Au repos (application déployée, sans trafic), par mois

| Poste | Calcul | ≈ $/mois sans offre gratuite |
|---|---|---|
| API : 1 × t3.micro | 730 h × 0,0108 $ | 7,9 |
| Temps réel : 1 × t3.small | 730 h × 0,0216 $ | 15,8 |
| Application Load Balancer | 730 h × ≈ 0,024 $ + LCU minimes | ≈ 18 |
| Adresses IPv4 publiques (2 instances + 2 nœuds d'ALB) | 4 × 730 h × 0,005 $ | 14,6 |
| DynamoDB à la demande, S3, SQS, SSM, CloudWatch Logs | volumes très faibles | < 2 |
| CloudFront | dans l'offre gratuite permanente (1 To, 10 M requêtes/mois) | 0 |
| **Total** | | **≈ 58 $/mois** |

L'offre gratuite couvre 750 h/mois de t3.micro et d'adresse IPv4 publique : le coût réel au
repos est d'environ **35 $/mois**, soit moins de 3 mois sur les 100 $ de crédits. Pour
la période d'évaluation (quelques jours), l'ordre de grandeur est de **quelques dollars**.
Après la soutenance, `scripts/destroy.sh` ramène le coût à zéro.

### 2.2 Un pic (15 000 visiteurs, 300 rédacteurs)

| Poste | Calcul | ≈ $ |
|---|---|---|
| 3 instances API en plus pendant ≈ 25 min | 3 × 0,42 h × 0,0108 $ | 0,02 |
| DynamoDB : ≈ 5 000 décréments + 5 000 réservations + lectures de `seq` ; rédacteurs : ≈ 10 transactions/s/document × 30 documents | quelques centaines de milliers d'unités | < 0,5 |
| CloudFront, ALB (LCU), SQS, S3 (PDF de quelques Ko × 5 000 téléchargements) | | < 0,2 |
| **Total par pic** | | **< 1 $** |

### 2.3 Test de charge

| Poste | Calcul | ≈ $ |
|---|---|---|
| Instance k6 c7i-flex.large (≈ 1 h, création → destruction) | 1 h × ≈ 0,09 $ | 0,09 |
| Pic simulé sur l'application | §2.2 | < 1 |
| Bucket de résultats (Mo) | | ≈ 0 |

## 3. Preuve (facturation AWS)

Relevé à faire dans **Billing → Cost Explorer** (ou par la commande du §4), filtré sur la
période du projet, par service. Les données de facturation ont environ 24 h de retard.

| Date du relevé | Période | Total | Principaux postes | Crédits restants |
|---|---|---|---|---|
| 26/10/2026 | 24/10 → 26/10 | ≈ 0 $ (données du 25/10 pas encore publiées) | — | ≈ 100 $ |
| _à compléter avant la soutenance_ | 24/10 → jour J | | EC2, ELB, VPC (IPv4), DynamoDB | |

Joindre la capture d'écran de Cost Explorer (coûts par service) et de la page *Credits*
dans `docs/` au moment du relevé.

## 4. Vérifier soi-même

```bash
# Coût par service et par jour (Cost Explorer facture 0,01 $ par appel d'API)
aws ce get-cost-and-usage --region us-east-1 \
  --time-period Start=2026-10-24,End=2026-10-28 --granularity DAILY \
  --metrics UnblendedCost --group-by Type=DIMENSION,Key=SERVICE

# Ressources du projet (toutes étiquetées projet=editeur-partage)
aws resourcegroupstaggingapi get-resources --region eu-north-1 \
  --tag-filters Key=projet,Values=editeur-partage --query 'ResourceTagMappingList[].ResourceARN'
```

Pour filtrer la facturation sur l'étiquette `projet`, il faut l'activer comme étiquette
de répartition des coûts (Billing → Cost allocation tags) ; elle n'apparaît dans Cost
Explorer que pour les coûts postérieurs à son activation (délai d'environ 24 h).

Alerte de budget recommandée : Billing → Budgets → budget mensuel de 20 $ avec alerte par
e-mail à 80 %.
