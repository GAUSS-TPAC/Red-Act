import {
  CfnOutput,
  CfnParameter,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_autoscaling as autoscaling,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_dynamodb as dynamodb,
  aws_ec2 as ec2,
  aws_elasticloadbalancingv2 as elbv2,
  aws_iam as iam,
  aws_s3 as s3,
  aws_s3_assets as s3assets,
} from "aws-cdk-lib";
import type { Construct } from "constructs";
import { SSM_PARAMS, TABLES, type TableDef, type TableKey } from "@editeur/shared";

const API_PORT = 3000;

/**
 * Actions DynamoDB du rôle API, table par table (moindre privilège).
 * Prévues pour les étapes 2 et 6 du §10 (liens, réservations, admin) ;
 * le journal et les crédits ne sont écrits que par le serveur temps réel.
 */
const API_TABLE_ACTIONS: Partial<Record<TableKey, string[]>> = {
  documents: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
  links: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"],
  reservations: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
  blocks: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Scan"],
  presence: ["dynamodb:Scan"],
  versions: ["dynamodb:Query"],
};

export interface MainStackProps extends StackProps {
  /** Dossier du bundle esbuild de l'API (`npm run build`). */
  apiBundleDir: string;
}

export class MainStack extends Stack {
  constructor(scope: Construct, id: string, props: MainStackProps) {
    super(scope, id, props);

    // Identifiant de la liste de préfixes gérée « com.amazonaws.global.cloudfront.origin-facing »,
    // fourni au déploiement (lecture seule : aws ec2 describe-managed-prefix-lists).
    const cloudfrontPrefixList = new CfnParameter(this, "CloudFrontPrefixListId", {
      type: "String",
      allowedPattern: "^pl-[0-9a-f]+$",
      description: "Liste de préfixes gérée CloudFront origin-facing de la région",
    });

    // --- Réseau : 2 AZ, sous-réseaux publics, pas de NAT (coût), endpoints gateway gratuits.
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
      gatewayEndpoints: {
        S3: { service: ec2.GatewayVpcEndpointAwsService.S3 },
        DynamoDB: { service: ec2.GatewayVpcEndpointAwsService.DYNAMODB },
      },
    });

    // --- Données
    const tables = Object.fromEntries(
      (Object.entries(TABLES) as [TableKey, TableDef][]).map(([key, def]) => [key, this.table(key, def)]),
    ) as Record<TableKey, dynamodb.Table>;

    const bucket = new s3.Bucket(this, "Fichiers", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      lifecycleRules: [
        { noncurrentVersionExpiration: Duration.days(30) },
        { abortIncompleteMultipartUploadAfter: Duration.days(1) },
      ],
      // Le bucket versionné est vidé par scripts/destroy.sh avant cdk destroy.
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // --- Équilibreur : n'accepte que CloudFront.
    const albSg = new ec2.SecurityGroup(this, "AlbSg", {
      vpc,
      allowAllOutbound: false,
      description: "ALB - HTTP depuis CloudFront uniquement",
    });
    albSg.addIngressRule(ec2.Peer.prefixList(cloudfrontPrefixList.valueAsString), ec2.Port.tcp(80));

    const alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    // --- Instances API : sans état, 2 AZ, aucun port 22 (accès par Session Manager).
    const apiSg = new ec2.SecurityGroup(this, "ApiSg", {
      vpc,
      description: "Instances API - trafic depuis l ALB uniquement",
    });
    apiSg.addIngressRule(albSg, ec2.Port.tcp(API_PORT));
    albSg.addEgressRule(apiSg, ec2.Port.tcp(API_PORT));

    const apiRole = new iam.Role(this, "ApiRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      description: "Instances API",
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")],
    });
    for (const [key, actions] of Object.entries(API_TABLE_ACTIONS) as [TableKey, string[]][]) {
      tables[key].grant(apiRole, ...actions);
    }
    // URL pré-signées des PDF : la signature porte les droits du rôle.
    bucket.grantRead(apiRole, "pdf/*");
    apiRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: Object.values(SSM_PARAMS).map((name) =>
          this.formatArn({ service: "ssm", resource: "parameter", resourceName: name.slice(1) }),
        ),
      }),
    );

    const apiBundle = new s3assets.Asset(this, "ApiBundle", { path: props.apiBundleDir });
    apiBundle.grantRead(apiRole);

    const userData = ec2.UserData.forLinux();
    const zip = userData.addS3DownloadCommand({
      bucket: apiBundle.bucket,
      bucketKey: apiBundle.s3ObjectKey,
      localFile: "/tmp/api.zip",
    });
    userData.addCommands(
      "set -euo pipefail",
      "dnf install -y nodejs20 unzip",
      "useradd --system --no-create-home --shell /sbin/nologin editeur || true",
      "mkdir -p /opt/editeur/api /etc/editeur",
      `unzip -o ${zip} -d /opt/editeur/api`,
      "cat > /etc/editeur/api.env <<'EOF'",
      `PORT=${API_PORT}`,
      `AWS_REGION=${this.region}`,
      `BUCKET=${bucket.bucketName}`,
      "EOF",
      "cat > /etc/systemd/system/editeur-api.service <<'EOF'",
      "[Unit]",
      "Description=Editeur partage - API",
      "After=network-online.target",
      "[Service]",
      "User=editeur",
      "EnvironmentFile=/etc/editeur/api.env",
      "ExecStart=/usr/bin/node-20 /opt/editeur/api/server.cjs",
      "Restart=always",
      "NoNewPrivileges=true",
      "ProtectSystem=strict",
      "[Install]",
      "WantedBy=multi-user.target",
      "EOF",
      "systemctl daemon-reload",
      "systemctl enable --now editeur-api",
    );

    const apiTemplate = new ec2.LaunchTemplate(this, "ApiTemplate", {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      role: apiRole,
      securityGroup: apiSg,
      userData,
      requireImdsv2: true,
      associatePublicIpAddress: true,
    });

    const apiAsg = new autoscaling.AutoScalingGroup(this, "ApiAsg", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      launchTemplate: apiTemplate,
      minCapacity: 1,
      maxCapacity: 4,
      healthChecks: autoscaling.HealthChecks.withAdditionalChecks({
        additionalTypes: [autoscaling.AdditionalHealthCheckType.ELB],
        gracePeriod: Duration.minutes(3),
      }),
      updatePolicy: autoscaling.UpdatePolicy.rollingUpdate(),
    });

    const listener = alb.addListener("Http", { port: 80, open: false });
    listener.addTargets("Api", {
      port: API_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [apiAsg],
      healthCheck: { path: "/sante", interval: Duration.seconds(15), healthyThresholdCount: 2 },
      deregistrationDelay: Duration.seconds(30),
    });
    // §4 : aucun chemin interne n'est joignable depuis l'extérieur.
    listener.addAction("BloqueInterne", {
      priority: 1,
      conditions: [elbv2.ListenerCondition.pathPatterns(["/internal*"])],
      action: elbv2.ListenerAction.fixedResponse(403, { contentType: "text/plain", messageBody: "Interdit" }),
    });

    // --- CloudFront : HTTPS par défaut (*.cloudfront.net), rien en cache, en-têtes du visiteur
    // transmis (CloudFront-Viewer-Address, WebSocket, cookies du ticket).
    const distribution = new cloudfront.Distribution(this, "Cdn", {
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: new origins.LoadBalancerV2Origin(alb, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_AND_CLOUDFRONT_2022,
      },
    });

    new CfnOutput(this, "Url", { value: `https://${distribution.distributionDomainName}` });
    new CfnOutput(this, "BucketName", { value: bucket.bucketName });
    new CfnOutput(this, "ApiAsgName", { value: apiAsg.autoScalingGroupName });
  }

  private table(key: TableKey, def: TableDef): dynamodb.Table {
    const attr = (k: { name: string; type: string }) => ({
      name: k.name,
      type: k.type as dynamodb.AttributeType,
    });
    const table = new dynamodb.Table(this, `Table-${key}`, {
      tableName: def.tableName,
      partitionKey: attr(def.partitionKey),
      sortKey: def.sortKey ? attr(def.sortKey) : undefined,
      timeToLiveAttribute: def.ttlAttribute,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    for (const index of def.globalIndexes ?? []) {
      table.addGlobalSecondaryIndex({
        indexName: index.indexName,
        partitionKey: attr(index.partitionKey),
        sortKey: index.sortKey ? attr(index.sortKey) : undefined,
      });
    }
    return table;
  }
}
