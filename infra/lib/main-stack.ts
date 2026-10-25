import {
  ArnFormat,
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
  aws_logs as logs,
  aws_s3 as s3,
  aws_s3_assets as s3assets,
  aws_ses as ses,
  aws_sqs as sqs,
} from "aws-cdk-lib";
import type { Construct } from "constructs";
import { LOAD_TEST_IP_PARAM, SSM_PARAMS, TABLES, type TableDef, type TableKey } from "@editeur/shared";

const API_PORT = 3000;
const REALTIME_PORT = 1234;

/**
 * Actions DynamoDB du rôle API, table par table (moindre privilège).
 * Prévues pour les étapes 2 et 6 du §10 (liens, réservations, partage, admin) ;
 * le journal et les crédits ne sont écrits que par le serveur temps réel.
 */
const API_TABLE_ACTIONS: Partial<Record<TableKey, string[]>> = {
  // Scan : liste des documents d'un rédacteur (filtrée sur editors).
  documents: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Scan"],
  // Lecture seule : affichage du crédit restant (seul le temps réel l'écrit).
  credits: ["dynamodb:GetItem"],
  links: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"],
  reservations: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
  blocks: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Scan"],
  presence: ["dynamodb:Scan"],
  versions: ["dynamodb:Query"],
};

/**
 * Actions DynamoDB du serveur temps réel. TransactWriteItems n'a pas d'action
 * propre : chaque élément de la transaction est autorisé par son action (§5).
 */
const REALTIME_TABLE_ACTIONS: Partial<Record<TableKey, string[]>> = {
  // GetItem : chargement et droits ; UpdateItem : seq et pointeur d'instantané ;
  // Scan : reprise des compactions au démarrage.
  documents: ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:Scan"],
  journal: ["dynamodb:PutItem", "dynamodb:Query"],
  credits: ["dynamodb:UpdateItem"],
  versions: ["dynamodb:PutItem"],
  // Anti-abus des rédacteurs (blocage 5 h) et battement de présence (tableau de bord).
  blocks: ["dynamodb:GetItem", "dynamodb:PutItem"],
  presence: ["dynamodb:PutItem"],
};

export interface MainStackProps extends StackProps {
  /** Dossier du bundle esbuild de l'API (`npm run build`). */
  apiBundleDir: string;
  /** Dossier du bundle esbuild du serveur temps réel. */
  realtimeBundleDir: string;
  /** Expéditeur SES vérifié (contexte `-c sesSender=…`) ; sans lui, pas d'e-mail. */
  sesSender?: string;
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
        // Un PDF ne sert que le temps des téléchargements (URL de 60 s, tickets de 2 min) :
        // on ne garde pas un fichier par version du document.
        { prefix: "pdf/", expiration: Duration.days(1), noncurrentVersionExpiration: Duration.days(1) },
      ],
      // Le bucket versionné est vidé par scripts/destroy.sh avant cdk destroy.
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // --- Demandes de PDF de l'API vers le serveur temps réel (§7, validée par Alan).
    // Une demande n'a d'intérêt que quelques minutes : le visiteur qui patiente la renvoie.
    const pdfQueue = new sqs.Queue(this, "PdfRequests", {
      queueName: "editeur-pdf-requests",
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      visibilityTimeout: Duration.seconds(60),
      receiveMessageWaitTime: Duration.seconds(20),
      retentionPeriod: Duration.hours(1),
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // --- Journaux des services (agent CloudWatch sur les instances), 1 semaine.
    for (const name of ["api", "realtime"]) {
      new logs.LogGroup(this, `Logs-${name}`, {
        logGroupName: `/editeur/${name}`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      });
    }

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
    pdfQueue.grantSendMessages(apiRole);
    apiRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [...Object.values(SSM_PARAMS), LOAD_TEST_IP_PARAM].map((name) =>
          this.formatArn({ service: "ssm", resource: "parameter", resourceName: name.slice(1) }),
        ),
      }),
    );

    const apiUserData = this.serviceUserData("api", props.apiBundleDir, apiRole, {
      PORT: String(API_PORT),
      AWS_REGION: this.region,
      BUCKET: bucket.bucketName,
      QUEUE_URL: pdfQueue.queueUrl,
      ...(props.sesSender ? { SES_SENDER: props.sesSender } : {}),
    });

    const apiTemplate = new ec2.LaunchTemplate(this, "ApiTemplate", {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      role: apiRole,
      securityGroup: apiSg,
      userData: apiUserData,
      requireImdsv2: true,
      // L'API lit le nom de son ASG dans les tags d'instance (seuil 30/N, actions programmées).
      instanceMetadataTags: true,
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
    // Scaling réactif sur les requêtes par instance (§4) ; le pic annoncé est anticipé
    // par les actions programmées que l'API crée autour de `opensAt`.
    apiAsg.scaleOnRequestCount("RequetesParInstance", { targetRequestsPerMinute: 3000 });

    // Droits Auto Scaling de l'API, dans une politique à part (pas de cycle avec l'ASG) :
    // actions programmées sur SON ASG seulement ; DescribeAutoScalingGroups n'accepte
    // pas de restriction de ressource (lecture seule) — exception justifiée du §4.
    new iam.Policy(this, "ApiScaling", {
      roles: [apiRole],
      statements: [
        new iam.PolicyStatement({
          actions: ["autoscaling:PutScheduledUpdateGroupAction"],
          resources: [
            `arn:${this.partition}:autoscaling:${this.region}:${this.account}:autoScalingGroup:*:autoScalingGroupName/${apiAsg.autoScalingGroupName}`,
          ],
        }),
        new iam.PolicyStatement({ actions: ["autoscaling:DescribeAutoScalingGroups"], resources: ["*"] }),
      ],
    });

    // E-mail au créateur d'un lien à son dernier exemplaire (SES, bac à sable).
    if (props.sesSender) {
      const sender = new ses.EmailIdentity(this, "Expediteur", { identity: ses.Identity.email(props.sesSender) });
      sender.grantSendEmail(apiRole);
    }

    // §4 : aucun chemin interne n'est joignable depuis l'extérieur.
    listener.addAction("BloqueInterne", {
      priority: 1,
      conditions: [elbv2.ListenerCondition.pathPatterns(["/internal*"])],
      action: elbv2.ListenerAction.fixedResponse(403, { contentType: "text/plain", messageBody: "Interdit" }),
    });

    // --- Serveur temps réel : UNE seule instance (§4). Mise à jour : l'ancienne est arrêtée
    // avant le lancement de la nouvelle, jamais deux serveurs actifs sur un même document.
    const realtimeSg = new ec2.SecurityGroup(this, "RealtimeSg", {
      vpc,
      description: "Serveur temps reel - trafic depuis l ALB uniquement",
    });
    realtimeSg.addIngressRule(albSg, ec2.Port.tcp(REALTIME_PORT));
    albSg.addEgressRule(realtimeSg, ec2.Port.tcp(REALTIME_PORT));

    const realtimeRole = new iam.Role(this, "RealtimeRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      description: "Serveur temps reel",
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")],
    });
    for (const [key, actions] of Object.entries(REALTIME_TABLE_ACTIONS) as [TableKey, string[]][]) {
      tables[key].grant(realtimeRole, ...actions);
    }
    bucket.grantReadWrite(realtimeRole, "snapshots/*");
    bucket.grantPut(realtimeRole, "pdf/*");
    pdfQueue.grantConsumeMessages(realtimeRole);
    realtimeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [this.formatArn({ service: "ssm", resource: "parameter", resourceName: SSM_PARAMS.hmacSecret.slice(1) })],
      }),
    );

    const realtimeTemplate = new ec2.LaunchTemplate(this, "RealtimeTemplate", {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      role: realtimeRole,
      securityGroup: realtimeSg,
      userData: this.serviceUserData("realtime", props.realtimeBundleDir, realtimeRole, {
        PORT: String(REALTIME_PORT),
        AWS_REGION: this.region,
        BUCKET: bucket.bucketName,
        QUEUE_URL: pdfQueue.queueUrl,
      }),
      requireImdsv2: true,
      associatePublicIpAddress: true,
    });

    const realtimeAsg = new autoscaling.AutoScalingGroup(this, "RealtimeAsg", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      launchTemplate: realtimeTemplate,
      // min = max = 1 : toujours exactement une instance (sans desiredCapacity, que CDK
      // déconseille car il réinitialise la taille à chaque déploiement).
      minCapacity: 1,
      maxCapacity: 1,
      healthChecks: autoscaling.HealthChecks.withAdditionalChecks({
        additionalTypes: [autoscaling.AdditionalHealthCheckType.ELB],
        gracePeriod: Duration.minutes(3),
      }),
      updatePolicy: autoscaling.UpdatePolicy.rollingUpdate({ minInstancesInService: 0, maxBatchSize: 1 }),
    });

    listener.addTargets("Realtime", {
      priority: 10,
      conditions: [elbv2.ListenerCondition.pathPatterns(["/collab*"])],
      port: REALTIME_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [realtimeAsg],
      healthCheck: { path: "/sante", interval: Duration.seconds(15), healthyThresholdCount: 2 },
      deregistrationDelay: Duration.seconds(10),
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
      // Fichiers du front nommés par leur empreinte : mis en cache à la périphérie,
      // le pic de visiteurs (C5) ne les redemande pas aux instances API.
      additionalBehaviors: {
        "/assets/*": {
          origin: new origins.LoadBalancerV2Origin(alb, { protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        },
      },
    });

    new CfnOutput(this, "Url", { value: `https://${distribution.distributionDomainName}` });
    new CfnOutput(this, "BucketName", { value: bucket.bucketName });
    new CfnOutput(this, "ApiAsgName", { value: apiAsg.autoScalingGroupName });
    new CfnOutput(this, "RealtimeAsgName", { value: realtimeAsg.autoScalingGroupName });
  }

  /**
   * User data commun : Node 20, bundle esbuild récupéré via le rôle (asset CDK),
   * service systemd sous un utilisateur sans droits. Pas de npm install sur l'instance.
   */
  private serviceUserData(name: string, bundleDir: string, role: iam.IRole, env: Record<string, string>) {
    const id = `${name[0]!.toUpperCase()}${name.slice(1)}Bundle`; // ApiBundle, RealtimeBundle
    const bundle = new s3assets.Asset(this, id, { path: bundleDir });
    bundle.grantRead(role);
    // Journaux : l'agent CloudWatch n'écrit que dans le groupe du service.
    const logGroupArn = this.formatArn({
      service: "logs",
      resource: "log-group",
      resourceName: `/editeur/${name}:*`,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"],
        resources: [logGroupArn],
      }),
    );
    const agentConfig = JSON.stringify({
      logs: {
        logs_collected: {
          files: {
            collect_list: [
              { file_path: `/var/log/editeur/${name}.log`, log_group_name: `/editeur/${name}`, log_stream_name: "{instance_id}" },
            ],
          },
        },
      },
    });
    const userData = ec2.UserData.forLinux();
    const zip = userData.addS3DownloadCommand({
      bucket: bundle.bucket,
      bucketKey: bundle.s3ObjectKey,
      localFile: `/tmp/${name}.zip`,
    });
    userData.addCommands(
      "set -euo pipefail",
      "dnf install -y nodejs20 unzip amazon-cloudwatch-agent",
      "mkdir -p /var/log/editeur",
      `cat > /opt/aws/amazon-cloudwatch-agent/etc/editeur.json <<'EOF'`,
      agentConfig,
      "EOF",
      "/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/editeur.json",
      "useradd --system --no-create-home --shell /sbin/nologin editeur || true",
      `mkdir -p /opt/editeur/${name} /etc/editeur`,
      `unzip -o ${zip} -d /opt/editeur/${name}`,
      `cat > /etc/editeur/${name}.env <<'EOF'`,
      ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
      "EOF",
      `cat > /etc/systemd/system/editeur-${name}.service <<'EOF'`,
      "[Unit]",
      `Description=Editeur partage - ${name}`,
      "After=network-online.target",
      "[Service]",
      "User=editeur",
      `EnvironmentFile=/etc/editeur/${name}.env`,
      `ExecStart=/usr/bin/node-20 /opt/editeur/${name}/server.cjs`,
      // Ouvert par systemd (pas par le service) : envoyé à CloudWatch Logs par l'agent.
      `StandardOutput=append:/var/log/editeur/${name}.log`,
      `StandardError=append:/var/log/editeur/${name}.log`,
      "Restart=always",
      // Arrêt propre : le serveur temps réel vide ses écritures et compacte.
      "TimeoutStopSec=30",
      "NoNewPrivileges=true",
      "ProtectSystem=strict",
      "[Install]",
      "WantedBy=multi-user.target",
      "EOF",
      "systemctl daemon-reload",
      `systemctl enable --now editeur-${name}`,
    );
    return userData;
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
