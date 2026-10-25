/**
 * Services AWS annexes de l'API (étape 6) :
 *   - e-mail SES au créateur d'un lien à son dernier exemplaire ;
 *   - montée en charge programmée autour de `opensAt` (ASG API) ;
 *   - nom de l'ASG et nombre d'instances (seuil anti-abus 30/N).
 * Le nom de l'ASG est lu dans les métadonnées de l'instance (tag
 * aws:autoscaling:groupName), pour ne pas créer de dépendance circulaire dans le CDK.
 */
import {
  AutoScalingClient,
  DescribeAutoScalingGroupsCommand,
  PutScheduledUpdateGroupActionCommand,
} from "@aws-sdk/client-auto-scaling";
import { SendEmailCommand, SESClient } from "@aws-sdk/client-ses";
import { REGION, type LinkItem } from "@editeur/shared";

const region = () => process.env.AWS_REGION ?? REGION;

/** Montée : 10 min avant l'ouverture ; descente : 15 min après (§6). */
export const SCALE_UP_BEFORE_MS = 10 * 60 * 1000;
export const SCALE_DOWN_AFTER_MS = 15 * 60 * 1000;
/** Instances au moment du pic (= MaxSize de l'ASG API). */
export const PEAK_INSTANCES = 4;

export function sesNotifier(sender: string) {
  const ses = new SESClient({ region: region() });
  return async (link: LinkItem) => {
    await ses.send(
      new SendEmailCommand({
        Source: sender,
        Destination: { ToAddresses: [link.creatorEmail] },
        Message: {
          Subject: { Data: "Votre lien de téléchargement est épuisé", Charset: "UTF-8" },
          Body: {
            Text: {
              Charset: "UTF-8",
              Data:
                `Bonjour,\n\nLe dernier des ${link.max} exemplaires de votre lien (${link.linkId}) vient d'être réservé.\n` +
                `Les visiteurs suivants voient désormais « épuisé ».\n\n— Éditeur du journal`,
            },
          },
        },
      }),
    );
  };
}

/** Nom de l'ASG de cette instance (IMDSv2) ; undefined hors EC2. */
export async function ownAutoScalingGroup(): Promise<string | undefined> {
  try {
    const base = "http://169.254.169.254/latest";
    const token = await (
      await fetch(`${base}/api/token`, {
        method: "PUT",
        headers: { "X-aws-ec2-metadata-token-ttl-seconds": "300" },
        signal: AbortSignal.timeout(1000),
      })
    ).text();
    const response = await fetch(`${base}/meta-data/tags/instance/aws:autoscaling:groupName`, {
      headers: { "X-aws-ec2-metadata-token": token },
      signal: AbortSignal.timeout(1000),
    });
    return response.ok ? await response.text() : undefined;
  } catch {
    return undefined;
  }
}

export function autoScaling(asgName: string) {
  const client = new AutoScalingClient({ region: region() });
  return {
    /** Instances en service : N du seuil anti-abus. */
    async countInstances() {
      const result = await client.send(new DescribeAutoScalingGroupsCommand({ AutoScalingGroupNames: [asgName] }));
      return (result.AutoScalingGroups?.[0]?.Instances ?? []).filter((i) => i.LifecycleState === "InService").length;
    },
    /** Deux actions programmées par lien ouvert à heure fixe (noms uniques par lien). */
    async scheduleForLink(linkId: string, opensAt: number, now = Date.now()) {
      // AWS exige une heure future : si l'ouverture est proche, la montée part dans 1 min.
      const up = Math.max(opensAt - SCALE_UP_BEFORE_MS, now + 60_000);
      await client.send(
        new PutScheduledUpdateGroupActionCommand({
          AutoScalingGroupName: asgName,
          ScheduledActionName: `lien-${linkId}-montee`,
          StartTime: new Date(up),
          MinSize: PEAK_INSTANCES,
          DesiredCapacity: PEAK_INSTANCES,
        }),
      );
      // Descente : on rend seulement le minimum ; le scaling réactif réduit ensuite.
      await client.send(
        new PutScheduledUpdateGroupActionCommand({
          AutoScalingGroupName: asgName,
          ScheduledActionName: `lien-${linkId}-descente`,
          StartTime: new Date(Math.max(opensAt + SCALE_DOWN_AFTER_MS, up + 60_000)),
          MinSize: 1,
        }),
      );
    },
  };
}
