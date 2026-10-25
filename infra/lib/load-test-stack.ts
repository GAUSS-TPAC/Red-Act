/**
 * LoadTestStack (CLAUDE.md §10, étape 7) : une instance de test de charge en
 * eu-north-1, déployée seulement le temps des mesures puis détruite.
 *   - k6 (pic de 15 000 visiteurs) + Node 20 (300 rédacteurs, vrais clients Yjs) ;
 *   - accès par Session Manager (aucun port ouvert) ;
 *   - résultats bruts déposés dans un bucket dédié ;
 *   - son adresse IP publiée dans SSM pour être exemptée de l'anti-abus des visiteurs.
 */
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_ec2 as ec2,
  aws_iam as iam,
  aws_s3 as s3,
  aws_s3_assets as s3assets,
  aws_ssm as ssm,
} from "aws-cdk-lib";
import type { Construct } from "constructs";
import { LOAD_TEST_IP_PARAM } from "@editeur/shared";

/** k6 épinglé, empreinte vérifiée (publiée par Grafana avec la version). */
const K6_VERSION = "v2.2.0";
const K6_RPM_SHA256 = "855109dbd4734cb752eace4afd6c91fd416aa05b21a43554b1390c20a9f2e776";

export interface LoadTestStackProps extends StackProps {
  /** Scripts du test de charge (`npm run build` → tests/load/dist). */
  loadBundleDir: string;
}

export class LoadTestStack extends Stack {
  constructor(scope: Construct, id: string, props: LoadTestStackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [{ name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
    });
    const sg = new ec2.SecurityGroup(this, "Sg", { vpc, description: "Test de charge - aucune entree" });

    const results = new s3.Bucket(this, "Resultats", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{ expiration: Duration.days(30) }],
      // Vidé par le script de suppression avant cdk destroy (non versionné).
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const role = new iam.Role(this, "Role", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      description: "Instance de test de charge",
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")],
    });
    results.grantPut(role);

    const scripts = new s3assets.Asset(this, "Scripts", { path: props.loadBundleDir });
    scripts.grantRead(role);

    const userData = ec2.UserData.forLinux();
    const zip = userData.addS3DownloadCommand({ bucket: scripts.bucket, bucketKey: scripts.s3ObjectKey, localFile: "/tmp/charge.zip" });
    userData.addCommands(
      "set -euo pipefail",
      "dnf install -y nodejs20 unzip",
      "ln -sf /usr/bin/node-20 /usr/local/bin/node",
      `curl -sSL -o /tmp/k6.rpm https://github.com/grafana/k6/releases/download/${K6_VERSION}/k6-${K6_VERSION}-linux-amd64.rpm`,
      `echo "${K6_RPM_SHA256}  /tmp/k6.rpm" | sha256sum -c -`,
      "dnf install -y /tmp/k6.rpm",
      "mkdir -p /opt/charge",
      `unzip -o ${zip} -d /opt/charge`,
      "chmod +x /opt/charge/run.sh",
      `echo "export RESULTS_BUCKET=${results.bucketName}" > /etc/charge.env`,
      // Des milliers de connexions simultanées : descripteurs et ports éphémères.
      "echo '* soft nofile 200000' > /etc/security/limits.d/charge.conf",
      "echo '* hard nofile 200000' >> /etc/security/limits.d/charge.conf",
      "sysctl -w net.ipv4.ip_local_port_range='1024 65000'",
    );

    const instance = new ec2.Instance(this, "Instance", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      // 2 vCPU / 4 Go : k6 (~200 req/s) et 300 clients Yjs. Le compte (plan gratuit)
      // refuse les types hors offre gratuite (t3.medium refusé) : c7i-flex.large en fait partie.
      instanceType: new ec2.InstanceType("c7i-flex.large"),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: sg,
      role,
      userData,
      requireImdsv2: true,
      associatePublicIpAddress: true,
    });

    // L'API lit ce paramètre : les visiteurs simulés (une seule adresse) ne sont pas bloqués.
    new ssm.StringParameter(this, "IpCharge", {
      parameterName: LOAD_TEST_IP_PARAM,
      stringValue: instance.instancePublicIp,
      description: "Adresse de l'instance de test de charge (exemptee de l'anti-abus pendant le test)",
    });

    new CfnOutput(this, "InstanceId", { value: instance.instanceId });
    new CfnOutput(this, "ResultsBucket", { value: results.bucketName });
  }
}
