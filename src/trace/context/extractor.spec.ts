import { Context } from "aws-lambda";
import { awsXrayDaemonAddressEnvVar, xrayTraceEnvVar } from "../xray-service";
import {
  SampleMode,
  Source,
  extractTraceContext,
  parentIDHeader,
  readTraceFromEvent,
  samplingPriorityHeader,
  traceIDHeader,
} from "./extractor";
import { readTraceFromHTTPEvent } from "./extractors/http";
import { LogLevel, setLogLevel } from "../../utils";

let sentSegment: any;
let closedSocket = false;

jest.mock("dgram", () => {
  return {
    createSocket: () => {
      return {
        send: (
          message: string,
          start: number,
          length: number,
          port: number,
          address: string,
          callback: (error: string | undefined, bytes: number) => void,
        ) => {
          sentSegment = message;
          callback(undefined, 1);
        },
        close: () => {
          closedSocket = true;
        },
      };
    },
  };
});
jest.mock("crypto", () => {
  return {
    randomBytes: () => "11111",
  };
});

beforeEach(() => {
  sentSegment = undefined;
  closedSocket = false;
  setLogLevel(LogLevel.NONE);
});

describe("extractTraceContext", () => {
  afterEach(() => {
    process.env["_X_AMZN_TRACE_ID"] = undefined;
    process.env[awsXrayDaemonAddressEnvVar] = undefined;
  });
  it("returns trace read from header as highest priority with no extractor", async () => {
    process.env["_X_AMZN_TRACE_ID"] = "Root=1-5ce31dc2-2c779014b90ce44db5e03875;Parent=0b11cc4230d3e09e;Sampled=1";

    const result = await extractTraceContext(
      {
        headers: {
          "x-datadog-parent-id": "797643193680388251",
          "x-datadog-sampling-priority": "2",
          "x-datadog-trace-id": "4110911582297405551",
        },
      },
      {} as Context,
    );
    expect(result).toEqual({
      parentID: "797643193680388251",
      sampleMode: SampleMode.USER_KEEP,
      traceID: "4110911582297405551",
      source: Source.Event,
    });
  });
  it("returns an empty context when headers are null", async () => {
    const result = await extractTraceContext(
      {
        headers: null,
      },
      {} as Context,
    );
    expect(result).toEqual(undefined);
  });

  it("returns trace read from event with an async extractor as the highest priority", async () => {
    process.env["_X_AMZN_TRACE_ID"] = "Root=1-5ce31dc2-2c779014b90ce44db5e03875;Parent=0b11cc4230d3e09e;Sampled=1";

    const extractor = async (event: any, context: Context) => {
      const traceID = event.foo[traceIDHeader];
      const parentID = event.foo[parentIDHeader];
      const sampledHeader = event.foo[samplingPriorityHeader];
      const sampleMode = parseInt(sampledHeader, 10);

      return {
        parentID,
        sampleMode,
        source: Source.Event,
        traceID,
      };
    };

    const result = await extractTraceContext(
      {
        foo: {
          "x-datadog-parent-id": "797643193680388251",
          "x-datadog-sampling-priority": "2",
          "x-datadog-trace-id": "4110911582297405551",
        },
      },
      {} as Context,
      extractor,
    );
    expect(result).toEqual({
      parentID: "797643193680388251",
      sampleMode: SampleMode.USER_KEEP,
      traceID: "4110911582297405551",
      source: Source.Event,
    });
  });

  it("returns trace read from event with a synchronous extractor as the highest priority", async () => {
    process.env["_X_AMZN_TRACE_ID"] = "Root=1-5ce31dc2-2c779014b90ce44db5e03875;Parent=0b11cc4230d3e09e;Sampled=1";

    const extractor = (event: any, context: Context) => {
      const traceID = event.foo[traceIDHeader];
      const parentID = event.foo[parentIDHeader];
      const sampledHeader = event.foo[samplingPriorityHeader];
      const sampleMode = parseInt(sampledHeader, 10);

      return {
        parentID,
        sampleMode,
        source: Source.Event,
        traceID,
      };
    };

    const result = await extractTraceContext(
      {
        foo: {
          "x-datadog-parent-id": "797643193680388251",
          "x-datadog-sampling-priority": "2",
          "x-datadog-trace-id": "4110911582297405551",
        },
      },
      {} as Context,
      extractor,
    );
    expect(result).toEqual({
      parentID: "797643193680388251",
      sampleMode: SampleMode.USER_KEEP,
      traceID: "4110911582297405551",
      source: Source.Event,
    });
  });

  it("handles gracefully errors in extractors", async () => {
    process.env["_X_AMZN_TRACE_ID"] = "Root=1-5ce31dc2-2c779014b90ce44db5e03875;Parent=0b11cc4230d3e09e;Sampled=1";

    const extractor = (event: any, context: Context) => {
      throw new Error("test");
    };

    const result = await extractTraceContext(
      {
        foo: {
          "x-datadog-parent-id": "797643193680388251",
          "x-datadog-sampling-priority": "2",
          "x-datadog-trace-id": "4110911582297405551",
        },
      },
      {} as Context,
      extractor,
    );
    expect(result).toEqual({
      parentID: "797643193680388254",
      sampleMode: SampleMode.USER_KEEP,
      traceID: "4110911582297405557",
      source: "xray",
    });
  });
  it("returns trace read from SQS metadata as second highest priority", async () => {
    process.env["_X_AMZN_TRACE_ID"] = "Root=1-5ce31dc2-2c779014b90ce44db5e03875;Parent=0b11cc4230d3e09e;Sampled=1";

    const result = await extractTraceContext(
      {
        Records: [
          {
            body: "Hello world",
            attributes: {
              ApproximateReceiveCount: "1",
              SentTimestamp: "1605544528092",
              SenderId: "AROAYYB64AB3JHSRKO6XR:sqs-trace-dev-producer",
              ApproximateFirstReceiveTimestamp: "1605544528094",
            },
            messageAttributes: {
              _datadog: {
                stringValue:
                  '{"x-datadog-trace-id":"4555236104497098341","x-datadog-parent-id":"3369753143434738315","x-datadog-sampled":"1","x-datadog-sampling-priority":"1"}',
                stringListValues: [],
                binaryListValues: [],
                dataType: "String",
              },
            },
            eventSource: "aws:sqs",
            eventSourceARN: "arn:aws:sqs:eu-west-1:601427279990:metal-queue",
            awsRegion: "eu-west-1",
          },
        ],
      },
      {} as Context,
    );
    expect(result).toEqual({
      parentID: "3369753143434738315",
      sampleMode: SampleMode.AUTO_KEEP,
      traceID: "4555236104497098341",
      source: Source.Event,
    });
  });
  it("returns trace read from Lambda Context as third highest priority", async () => {
    process.env["_X_AMZN_TRACE_ID"] = "Root=1-5ce31dc2-2c779014b90ce44db5e03875;Parent=0b11cc4230d3e09e;Sampled=1";
    const lambdaContext: Context = {
      clientContext: {
        custom: {
          _datadog: {
            "x-datadog-trace-id": "4555236104497098341",
            "x-datadog-parent-id": "3369753143434738315",
            "x-datadog-sampled": "1",
            "x-datadog-sampling-priority": "1",
          },
        },
      },
    } as any;
    const result = await extractTraceContext(
      {
        Records: [
          {
            body: "Hello world",
            attributes: {
              ApproximateReceiveCount: "1",
              SentTimestamp: "1605544528092",
              SenderId: "AROAYYB64AB3JHSRKO6XR:sqs-trace-dev-producer",
              ApproximateFirstReceiveTimestamp: "1605544528094",
            },
            messageAttributes: {
              _datadog: {
                stringValue: '{"x-datadog-parent-id":"666","x-datadog-sampled":"1","x-datadog-sampling-priority":"1"}',
                stringListValues: [],
                binaryListValues: [],
                dataType: "String",
              },
            },
            eventSource: "aws:sqs",
            eventSourceARN: "arn:aws:sqs:eu-west-1:601427279990:metal-queue",
            awsRegion: "eu-west-1",
          },
        ],
      },
      lambdaContext,
    );
    expect(result).toEqual({
      parentID: "3369753143434738315",
      sampleMode: SampleMode.AUTO_KEEP,
      traceID: "4555236104497098341",
      source: Source.Event,
    });
  });
  it("returns trace read from env if no headers present", async () => {
    process.env["_X_AMZN_TRACE_ID"] = "Root=1-5ce31dc2-2c779014b90ce44db5e03875;Parent=0b11cc4230d3e09e;Sampled=1";

    const result = await extractTraceContext({}, {} as Context);
    expect(result).toEqual({
      parentID: "797643193680388254",
      sampleMode: SampleMode.USER_KEEP,
      traceID: "4110911582297405557",
      source: "xray",
    });
  });
  it("returns trace read from env if no headers present", async () => {
    process.env["_X_AMZN_TRACE_ID"] = "Root=1-5ce31dc2-2c779014b90ce44db5e03875;Parent=0b11cc4230d3e09e;Sampled=1";

    const result = await extractTraceContext({}, {} as Context);
    expect(result).toEqual({
      parentID: "797643193680388254",
      sampleMode: SampleMode.USER_KEEP,
      traceID: "4110911582297405557",
      source: "xray",
    });
  });
  it("adds datadog metadata segment to xray when trace context is in event", async () => {
    jest.spyOn(Date, "now").mockImplementation(() => 1487076708000);
    process.env[xrayTraceEnvVar] = "Root=1-5e272390-8c398be037738dc042009320;Parent=94ae789b969f1cc5;Sampled=1";
    process.env[awsXrayDaemonAddressEnvVar] = "localhost:127.0.0.1:2000";

    const result = await extractTraceContext(
      {
        headers: {
          "x-datadog-parent-id": "797643193680388251",
          "x-datadog-sampling-priority": "2",
          "x-datadog-trace-id": "4110911582297405551",
        },
      },
      {} as Context,
    );

    expect(sentSegment instanceof Buffer).toBeTruthy();
    expect(closedSocket).toBeTruthy();
    const sentMessage = sentSegment.toString();
    expect(sentMessage).toMatchInlineSnapshot(`
      "{\\"format\\": \\"json\\", \\"version\\": 1}
      {\\"id\\":\\"11111\\",\\"trace_id\\":\\"1-5e272390-8c398be037738dc042009320\\",\\"parent_id\\":\\"94ae789b969f1cc5\\",\\"name\\":\\"datadog-metadata\\",\\"start_time\\":1487076708,\\"end_time\\":1487076708,\\"type\\":\\"subsegment\\",\\"metadata\\":{\\"datadog\\":{\\"trace\\":{\\"parent-id\\":\\"797643193680388251\\",\\"sampling-priority\\":\\"2\\",\\"trace-id\\":\\"4110911582297405551\\"}}}}"
    `);
  });
  it("skips adding datadog metadata to x-ray when daemon isn't present", async () => {
    jest.spyOn(Date, "now").mockImplementation(() => 1487076708000);
    process.env[xrayTraceEnvVar] = "Root=1-5e272390-8c398be037738dc042009320;Parent=94ae789b969f1cc5;Sampled=1";

    const result = await extractTraceContext(
      {
        headers: {
          "x-datadog-parent-id": "797643193680388251",
          "x-datadog-sampling-priority": "2",
          "x-datadog-trace-id": "4110911582297405551",
        },
      },
      {} as Context,
    );

    expect(sentSegment).toBeUndefined();
  });

  it("returns trace read from step functions event with the extractor as the highest priority", async () => {
    const stepFunctionEvent = {
      MyInput: "MyValue",
      Execution: {
        Id: "arn:aws:states:sa-east-1:425362996713:express:logs-to-traces-sequential:85a9933e-9e11-83dc-6a61-b92367b6c3be:3f7ef5c7-c8b8-4c88-90a1-d54aa7e7e2bf",
        Input: {
          MyInput: "MyValue",
        },
        Name: "85a9933e-9e11-83dc-6a61-b92367b6c3be",
        RoleArn: "arn:aws:iam::425362996713:role/service-role/StepFunctions-logs-to-traces-sequential-role-ccd69c03",
        StartTime: "2022-12-08T21:08:17.924Z",
      },
      State: {
        Name: "step-one",
        EnteredTime: "2022-12-08T21:08:19.224Z",
        RetryCount: 2,
      },
      StateMachine: {
        Id: "arn:aws:states:sa-east-1:425362996713:stateMachine:logs-to-traces-sequential",
        Name: "my-state-machine",
      },
    };

    const result = await extractTraceContext(stepFunctionEvent, {} as Context, undefined);
    expect(result).toEqual({
      parentID: "4602916161841036335",
      sampleMode: 1,
      traceID: "947965466153612645",
      source: "event",
    });
  });

  it("skips adding datadog metadata to x-ray when x-ray trace isn't sampled", async () => {
    jest.spyOn(Date, "now").mockImplementation(() => 1487076708000);
    process.env[xrayTraceEnvVar] = "Root=1-5e272390-8c398be037738dc042009320;Parent=94ae789b969f1cc5;Sampled=0";
    process.env[awsXrayDaemonAddressEnvVar] = "localhost:127.0.0.1:2000";

    const result = await extractTraceContext(
      {
        headers: {
          "x-datadog-parent-id": "797643193680388251",
          "x-datadog-sampling-priority": "2",
          "x-datadog-trace-id": "4110911582297405551",
        },
      },
      {} as Context,
    );

    expect(sentSegment).toBeUndefined();
  });

  it("adds step function metadata to xray", async () => {
    const stepFunctionEvent = {
      Execution: {
        Id: "arn:aws:states:sa-east-1:425362996713:express:logs-to-traces-sequential:85a9933e-9e11-83dc-6a61-b92367b6c3be:3f7ef5c7-c8b8-4c88-90a1-d54aa7e7e2bf",
        Name: "85a9933e-9e11-83dc-6a61-b92367b6c3be",
        RoleArn: "arn:aws:iam::425362996713:role/service-role/StepFunctions-logs-to-traces-sequential-role-ccd69c03",
        StartTime: "2022-12-08T21:08:17.924Z",
        Input: {
          MyInput: "MyValue",
        },
      },
      State: {
        Name: "step-one",
        EnteredTime: "2022-12-08T21:08:19.224Z",
        RetryCount: 2,
      },
      StateMachine: {
        Id: "arn:aws:states:sa-east-1:425362996713:stateMachine:logs-to-traces-sequential",
        Name: "my-state-machine",
      },
    } as const;

    jest.spyOn(Date, "now").mockImplementation(() => 1487076708000);
    process.env[xrayTraceEnvVar] = "Root=1-5e272390-8c398be037738dc042009320;Parent=94ae789b969f1cc5;Sampled=1";
    process.env[awsXrayDaemonAddressEnvVar] = "localhost:127.0.0.1:2000";

    await extractTraceContext(stepFunctionEvent, {} as Context);
    expect(sentSegment instanceof Buffer).toBeTruthy();

    expect(closedSocket).toBeTruthy();

    const sentMessage = sentSegment.toString();
    expect(sentMessage).toMatchInlineSnapshot(`
      "{\\"format\\": \\"json\\", \\"version\\": 1}
      {\\"id\\":\\"11111\\",\\"trace_id\\":\\"1-5e272390-8c398be037738dc042009320\\",\\"parent_id\\":\\"94ae789b969f1cc5\\",\\"name\\":\\"datadog-metadata\\",\\"start_time\\":1487076708,\\"end_time\\":1487076708,\\"type\\":\\"subsegment\\",\\"metadata\\":{\\"datadog\\":{\\"root_span_metadata\\":{\\"step_function.execution_name\\":\\"85a9933e-9e11-83dc-6a61-b92367b6c3be\\",\\"step_function.execution_id\\":\\"arn:aws:states:sa-east-1:425362996713:express:logs-to-traces-sequential:85a9933e-9e11-83dc-6a61-b92367b6c3be:3f7ef5c7-c8b8-4c88-90a1-d54aa7e7e2bf\\",\\"step_function.execution_input\\":{\\"MyInput\\":\\"MyValue\\"},\\"step_function.execution_role_arn\\":\\"arn:aws:iam::425362996713:role/service-role/StepFunctions-logs-to-traces-sequential-role-ccd69c03\\",\\"step_function.execution_start_time\\":\\"2022-12-08T21:08:17.924Z\\",\\"step_function.state_entered_time\\":\\"2022-12-08T21:08:19.224Z\\",\\"step_function.state_machine_arn\\":\\"arn:aws:states:sa-east-1:425362996713:stateMachine:logs-to-traces-sequential\\",\\"step_function.state_machine_name\\":\\"my-state-machine\\",\\"step_function.state_name\\":\\"step-one\\",\\"step_function.state_retry_count\\":2}}}}"
    `);
  });
});

describe("readTraceFromEvent", () => {
  it("can read well formed event with headers", () => {
    const result = readTraceFromEvent({
      headers: {
        "x-datadog-parent-id": "797643193680388254",
        "x-datadog-sampling-priority": "2",
        "x-datadog-trace-id": "4110911582297405557",
      },
    });
    expect(result).toEqual({
      parentID: "797643193680388254",
      sampleMode: SampleMode.USER_KEEP,
      traceID: "4110911582297405557",
      source: Source.Event,
    });
  });

  it("can read from sqs source", () => {
    const result = readTraceFromEvent({
      Records: [
        {
          body: "Hello world",
          attributes: {
            ApproximateReceiveCount: "1",
            SentTimestamp: "1605544528092",
            SenderId: "AROAYYB64AB3JHSRKO6XR:sqs-trace-dev-producer",
            ApproximateFirstReceiveTimestamp: "1605544528094",
          },
          messageAttributes: {
            _datadog: {
              stringValue:
                '{"x-datadog-trace-id":"4555236104497098341","x-datadog-parent-id":"3369753143434738315","x-datadog-sampled":"1","x-datadog-sampling-priority":"1"}',
              stringListValues: [],
              binaryListValues: [],
              dataType: "String",
            },
          },
          eventSource: "aws:sqs",
          eventSourceARN: "arn:aws:sqs:eu-west-1:601427279990:metal-queue",
          awsRegion: "eu-west-1",
        },
      ],
    });
    expect(result).toEqual({
      parentID: "3369753143434738315",
      sampleMode: SampleMode.AUTO_KEEP,
      traceID: "4555236104497098341",
      source: Source.Event,
    });
  });

  it("can parse a traced authorizer source", () => {
    const result = readTraceFromHTTPEvent({
      requestContext: {
        resourceId: "oozq9u",
        authorizer: {
          _datadog:
            "eyJ4LWRhdGFkb2ctdHJhY2UtaWQiOiIyMzg5NTg5OTU0MDI2MDkwMjk2IiwieC1kYXRhZG9nLXBhcmVudC1pZCI6IjIzODk1ODk5NTQwMjYwOTAyOTYiLCJ4LWRhdGFkb2ctc2FtcGxpbmctcHJpb3JpdHkiOiIxIiwieC1kYXRhZG9nLXBhcmVudC1zcGFuLWZpbmlzaC10aW1lIjoxNjYwOTM5ODk5MjMzLCJ4LWRhdGFkb2ctYXV0aG9yaXppbmctcmVxdWVzdGlkIjoicmFuZG9tLWlkIn0==",
          principalId: "foo",
          integrationLatency: 71,
          preserve: "this key set by a customer",
        },
        stage: "dev",
        requestId: "random-id",
      },
      httpMethod: "GET",
      resource: "/hello",
    });
    expect(result).toEqual({
      parentID: "2389589954026090296",
      sampleMode: 1,
      source: "event",
      traceID: "2389589954026090296",
    });
  });

  it("can parse an EventBridge message in an SQS queue", () => {
    const result = readTraceFromEvent({
      Records: [
        {
          messageId: "e995e54f-1724-41fa-82c0-8b81821f854e",
          receiptHandle:
            "AQEB4mIfRcyqtzn1X5Ss+ConhTejVGc+qnAcmu3/Z9ZvbNkaPcpuDLX/bzvPD/ZkAXJUXZcemGSJmd7L3snZHKMP2Ck8runZiyl4mubiLb444pZvdiNPuGRJ6a3FvgS/GQPzho/9nNMyOi66m8Viwh70v4EUCPGO4JmD3TTDAUrrcAnqU4WSObjfC/NAp9bI6wH2CEyAYEfex6Nxplbl/jBf9ZUG0I3m3vQd0Q4l4gd4jIR4oxQUglU2Tldl4Kx5fMUAhTRLAENri6HsY81avBkKd9FAuxONlsITB5uj02kOkvLlRGEcalqsKyPJ7AFaDLrOLaL3U+yReroPEJ5R5nwhLOEbeN5HROlZRXeaAwZOIN8BjqdeooYTIOrtvMEVb7a6OPLMdH1XB+ddevtKAH8K9Tm2ZjpaA7dtBGh1zFVHzBk=",
          body: '{"version":"0","id":"af718b2a-b987-e8c0-7a2b-a188fad2661a","detail-type":"my.Detail","source":"my.Source","account":"425362996713","time":"2023-08-03T22:49:03Z","region":"us-east-1","resources":[],"detail":{"text":"Hello, world!","_datadog":{"x-datadog-trace-id":"7379586022458917877","x-datadog-parent-id":"2644033662113726488","x-datadog-sampling-priority":"1","x-datadog-tags":"_dd.p.dm=-0","traceparent":"00-000000000000000066698e63821a03f5-24b17e9b6476c018-01","tracestate":"dd=t.dm:-0;s:1"}}}',
          attributes: {
            ApproximateReceiveCount: "1",
            AWSTraceHeader: "Root=1-64cc2edd-112fbf1701d1355973a11d57;Parent=7d5a9776024b2d42;Sampled=0",
            SentTimestamp: "1691102943638",
            SenderId: "AIDAJXNJGGKNS7OSV23OI",
            ApproximateFirstReceiveTimestamp: "1691102943647",
          },
          messageAttributes: {},
          md5OfBody: "93d9f0cd8886d1e000a1a0b7007bffc4",
          eventSource: "aws:sqs",
          eventSourceARN: "arn:aws:sqs:us-east-1:425362996713:lambda-eb-sqs-lambda-dev-demo-queue",
          awsRegion: "us-east-1",
        },
      ],
    });

    expect(result).toEqual({
      parentID: "2644033662113726488",
      sampleMode: 1,
      source: "event",
      traceID: "7379586022458917877",
    });
  });

  it("can parse an SNS message source", () => {
    const result = readTraceFromEvent({
      Records: [
        {
          EventSource: "aws:sns",
          EventVersion: "1.0",
          EventSubscriptionArn:
            "arn:aws:sns:eu-west-1:601427279990:aj-js-library-test-dev-solo-topic:1bd19208-a99a-46d9-8398-f90f8699c641",
          Sns: {
            Type: "Notification",
            MessageId: "f19d39fa-8c61-5df9-8f49-639247b6cece",
            TopicArn: "arn:aws:sns:eu-west-1:601427279990:aj-js-library-test-dev-solo-topic",
            Subject: null,
            Message: '{"hello":"there","ajTimestamp":1643039127879}',
            Timestamp: "2022-01-24T15:45:27.968Z",
            SignatureVersion: "1",
            Signature:
              "mzp2Ou0fASw4LYRxY6SSww7qFfofn4luCJBRaTjLpQ5uhwhsAUKdyLz9VPD+/dlRbi1ImsWtIZ7A+wxj1oV7Z2Gyu/N4RpGalae37+jTluDS7AhjgcD7Bs4bgQtFkCfMFEwbhICQfukLLzbwbgczZ4NTPn6zj5o28c5NBKSJMYSnLz82ohw77GgnZ/m26E32ZQNW4+VCEMINg9Ne2rHstwPWRXPr5xGTrx8jH8CNUZnVpFVfhU8o+OSeAdpzm2l99grHIo7qPhekERxANz6QHynMlhdzD3UNSgc3oZkamZban/NEKd4MKJzgNQdNOYVj3Kw6eF2ZweEoBQ5sSFK5fQ==",
            SigningCertUrl:
              "https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-7ff5318490ec183fbaddaa2a969abfda.pem",
            UnsubscribeUrl:
              "https://sns.eu-west-1.amazonaws.com/?Action=Unsubscribe&SubscriptionArn=arn:aws:sns:eu-west-1:601427279990:aj-js-library-test-dev-solo-topic:1bd19208-a99a-46d9-8398-f90f8699c641",
            MessageAttributes: {
              _datadog: {
                Type: "String",
                Value:
                  '{"x-datadog-trace-id":"6966585609680374559","x-datadog-parent-id":"4297634551783724228","x-datadog-sampled":"1","x-datadog-sampling-priority":"1"}',
              },
            },
          },
        },
      ],
    });
    expect(result).toEqual({
      parentID: "4297634551783724228",
      sampleMode: 1,
      source: "event",
      traceID: "6966585609680374559",
    });
  });

  it("can parse an SNS message source passing Binary trace context", () => {
    const result = readTraceFromEvent({
      Records: [
        {
          EventSource: "aws:sns",
          EventVersion: "1.0",
          EventSubscriptionArn:
            "arn:aws:sns:eu-west-1:601427279990:aj-js-library-test-dev-solo-topic:1bd19208-a99a-46d9-8398-f90f8699c641",
          Sns: {
            Type: "Notification",
            MessageId: "f19d39fa-8c61-5df9-8f49-639247b6cece",
            TopicArn: "arn:aws:sns:eu-west-1:601427279990:aj-js-library-test-dev-solo-topic",
            Subject: null,
            Message: '{"hello":"there","ajTimestamp":1643039127879}',
            Timestamp: "2022-01-24T15:45:27.968Z",
            SignatureVersion: "1",
            Signature:
              "mzp2Ou0fASw4LYRxY6SSww7qFfofn4luCJBRaTjLpQ5uhwhsAUKdyLz9VPD+/dlRbi1ImsWtIZ7A+wxj1oV7Z2Gyu/N4RpGalae37+jTluDS7AhjgcD7Bs4bgQtFkCfMFEwbhICQfukLLzbwbgczZ4NTPn6zj5o28c5NBKSJMYSnLz82ohw77GgnZ/m26E32ZQNW4+VCEMINg9Ne2rHstwPWRXPr5xGTrx8jH8CNUZnVpFVfhU8o+OSeAdpzm2l99grHIo7qPhekERxANz6QHynMlhdzD3UNSgc3oZkamZban/NEKd4MKJzgNQdNOYVj3Kw6eF2ZweEoBQ5sSFK5fQ==",
            SigningCertUrl:
              "https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-7ff5318490ec183fbaddaa2a969abfda.pem",
            UnsubscribeUrl:
              "https://sns.eu-west-1.amazonaws.com/?Action=Unsubscribe&SubscriptionArn=arn:aws:sns:eu-west-1:601427279990:aj-js-library-test-dev-solo-topic:1bd19208-a99a-46d9-8398-f90f8699c641",
            MessageAttributes: {
              _datadog: {
                Type: "Binary",
                Value:
                  "eyJ4LWRhdGFkb2ctdHJhY2UtaWQiOiI3MTAyMjkxNjI4NDQzMTM0OTE5IiwieC1kYXRhZG9nLXBhcmVudC1pZCI6IjQyNDc1NTAxMDE2NDg2MTg2MTgiLCJ4LWRhdGFkb2ctc2FtcGxpbmctcHJpb3JpdHkiOiIxIn0=",
              },
            },
          },
        },
      ],
    });
    expect(result).toEqual({
      parentID: "4247550101648618618",
      sampleMode: 1,
      source: "event",
      traceID: "7102291628443134919",
    });
  });

  it("can read from SNS message delivered to SQS queue source", () => {
    const result = readTraceFromEvent({
      Records: [
        {
          messageId: "64812b68-4d9b-4dca-b3fb-9b18f255ee51",
          receiptHandle:
            "AQEBER6aRkfG8092GvkL7FRwCwbQ7LLDW9Tlk/CembqHe+suS2kfFxXiukomvaIN61QoyQMoRgWuV52SDkiQno2u+5hP64BDbmw+e/KR9ayvIfHJ3M6RfyQLaWNWm3hDFBCKTnBMVIxtdx0N9epZZewyokjKcrNYtmCghFgTCvZzsQkowi5rnoHAVHJ3je1c3bDnQ1KLrZFgajDnootYXDwEPuMq5FIxrf4EzTe0S7S+rnRm+GaQfeBLBVAY6dASL9usV3/AFRqDtaI7GKI+0F2NCgLlqj49VlPRz4ldhkGknYlKTZTluAqALWLJS62/J1GQo53Cs3nneJcmu5ajB2zzmhhRXoXINEkLhCD5ujZfcsw9H4xqW69Or4ECvlqx14bUU2rtMIW0QM2p7pEeXnyocymQv6m1te113eYWTVmaJ4I=",
          body: '{\n  "Type" : "Notification",\n  "MessageId" : "0a0ab23e-4861-5447-82b7-e8094ff3e332",\n  "TopicArn" : "arn:aws:sns:eu-west-1:601427279990:js-library-test-dev-demoTopic-15WGUVRCBMPAA",\n  "Message" : "{\\"hello\\":\\"harv\\",\\"nice of you to join us\\":\\"david\\",\\"anotherThing\\":{\\"foo\\":\\"bar\\",\\"blah\\":null,\\"harv\\":123},\\"vals\\":[{\\"thingOne\\":1},{\\"thingTwo\\":2}],\\"ajTimestamp\\":1639777617957}",\n  "Timestamp" : "2021-12-17T21:46:58.040Z",\n  "SignatureVersion" : "1",\n  "Signature" : "FR35/7E8C3LHEVk/rC4XxXlXwV/5mNkFNPgDhHSnJ2I6hIoSrTROAm7h5xm1PuBkAeFDvq0zofw91ouk9zZyvhdrMLFIIgrjEyNayRmEffmoEAkzLFUsgtQX7MmTl644r4NuWiM0Oiz7jueRvIcKXcZr7Nc6GJcWV1ymec8oOmuHNMisnPMxI07LIQVYSyAfv6P9r2jEWMVIukRoCzwTnRk4bUUYhPSGHI7OC3AsxxXBbv8snqTrLM/4z2rXCf6jHCKNxWeLlm9/45PphCkEyx5BWS4/71KaoMWUWy8+6CCsy+uF3XTCVmvSEYLyEwTSzOY+vCUjazrRW93498i70g==",\n  "SigningCertURL" : "https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-7ff5318490ec183fbaddaa2a969abfda.pem",\n  "UnsubscribeURL" : "https://sns.eu-west-1.amazonaws.com/?Action=Unsubscribe&SubscriptionArn=arn:aws:sns:eu-west-1:601427279990:js-library-test-dev-demoTopic-15WGUVRCBMPAA:1290f550-9a8a-4e8f-a900-8f5f96dcddda",\n  "MessageAttributes" : {\n    "_datadog" : {"Type":"String","Value":"{\\"x-datadog-trace-id\\":\\"2776434475358637757\\",\\"x-datadog-parent-id\\":\\"4493917105238181843\\",\\"x-datadog-sampled\\":\\"1\\",\\"x-datadog-sampling-priority\\":\\"1\\"}"}\n  }\n}',
          attributes: {
            ApproximateReceiveCount: "1",
            SentTimestamp: "1639777618130",
            SenderId: "AIDAIOA2GYWSHW4E2VXIO",
            ApproximateFirstReceiveTimestamp: "1639777618132",
          },
          messageAttributes: {},
          md5OfBody: "ee19d8b1377919239ad3fd5dabc33739",
          eventSource: "aws:sqs",
          eventSourceARN: "arn:aws:sqs:eu-west-1:601427279990:aj-js-library-test-dev-demo-queue",
          awsRegion: "eu-west-1",
        },
      ],
    });
    expect(result).toEqual({
      parentID: "4493917105238181843",
      sampleMode: 1,
      source: "event",
      traceID: "2776434475358637757",
    });
  });

  it("can read from SNS message delivered to SQS queue source with Binary trace context", () => {
    const result = readTraceFromEvent({
      Records: [
        {
          messageId: "64812b68-4d9b-4dca-b3fb-9b18f255ee51",
          receiptHandle:
            "AQEBER6aRkfG8092GvkL7FRwCwbQ7LLDW9Tlk/CembqHe+suS2kfFxXiukomvaIN61QoyQMoRgWuV52SDkiQno2u+5hP64BDbmw+e/KR9ayvIfHJ3M6RfyQLaWNWm3hDFBCKTnBMVIxtdx0N9epZZewyokjKcrNYtmCghFgTCvZzsQkowi5rnoHAVHJ3je1c3bDnQ1KLrZFgajDnootYXDwEPuMq5FIxrf4EzTe0S7S+rnRm+GaQfeBLBVAY6dASL9usV3/AFRqDtaI7GKI+0F2NCgLlqj49VlPRz4ldhkGknYlKTZTluAqALWLJS62/J1GQo53Cs3nneJcmu5ajB2zzmhhRXoXINEkLhCD5ujZfcsw9H4xqW69Or4ECvlqx14bUU2rtMIW0QM2p7pEeXnyocymQv6m1te113eYWTVmaJ4I=",
          body: '{\n  "Type" : "Notification",\n  "MessageId" : "0a0ab23e-4861-5447-82b7-e8094ff3e332",\n  "TopicArn" : "arn:aws:sns:eu-west-1:601427279990:js-library-test-dev-demoTopic-15WGUVRCBMPAA",\n  "Message" : "{\\"hello\\":\\"harv\\",\\"nice of you to join us\\":\\"david\\",\\"anotherThing\\":{\\"foo\\":\\"bar\\",\\"blah\\":null,\\"harv\\":123},\\"vals\\":[{\\"thingOne\\":1},{\\"thingTwo\\":2}],\\"ajTimestamp\\":1639777617957}",\n  "Timestamp" : "2021-12-17T21:46:58.040Z",\n  "SignatureVersion" : "1",\n  "Signature" : "FR35/7E8C3LHEVk/rC4XxXlXwV/5mNkFNPgDhHSnJ2I6hIoSrTROAm7h5xm1PuBkAeFDvq0zofw91ouk9zZyvhdrMLFIIgrjEyNayRmEffmoEAkzLFUsgtQX7MmTl644r4NuWiM0Oiz7jueRvIcKXcZr7Nc6GJcWV1ymec8oOmuHNMisnPMxI07LIQVYSyAfv6P9r2jEWMVIukRoCzwTnRk4bUUYhPSGHI7OC3AsxxXBbv8snqTrLM/4z2rXCf6jHCKNxWeLlm9/45PphCkEyx5BWS4/71KaoMWUWy8+6CCsy+uF3XTCVmvSEYLyEwTSzOY+vCUjazrRW93498i70g==",\n  "SigningCertURL" : "https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-7ff5318490ec183fbaddaa2a969abfda.pem",\n  "UnsubscribeURL" : "https://sns.eu-west-1.amazonaws.com/?Action=Unsubscribe&SubscriptionArn=arn:aws:sns:eu-west-1:601427279990:js-library-test-dev-demoTopic-15WGUVRCBMPAA:1290f550-9a8a-4e8f-a900-8f5f96dcddda",\n  "MessageAttributes" : {\n    "_datadog" : {"Type":"Binary","Value":"eyJ4LWRhdGFkb2ctdHJhY2UtaWQiOiI3MTAyMjkxNjI4NDQzMTM0OTE5IiwieC1kYXRhZG9nLXBhcmVudC1pZCI6IjQyNDc1NTAxMDE2NDg2MTg2MTgiLCJ4LWRhdGFkb2ctc2FtcGxpbmctcHJpb3JpdHkiOiIxIn0="}\n  }\n}',
          attributes: {
            ApproximateReceiveCount: "1",
            SentTimestamp: "1639777618130",
            SenderId: "AIDAIOA2GYWSHW4E2VXIO",
            ApproximateFirstReceiveTimestamp: "1639777618132",
          },
          messageAttributes: {},
          md5OfBody: "ee19d8b1377919239ad3fd5dabc33739",
          eventSource: "aws:sqs",
          eventSourceARN: "arn:aws:sqs:eu-west-1:601427279990:aj-js-library-test-dev-demo-queue",
          awsRegion: "eu-west-1",
        },
      ],
    });
    expect(result).toEqual({
      parentID: "4247550101648618618",
      sampleMode: 1,
      source: "event",
      traceID: "7102291628443134919",
    });
  });

  it("can read context from EventBridge messages", () => {
    const result = readTraceFromEvent({
      version: "0",
      id: "bd3c8258-8d30-007c-2562-64715b2d0ea8",
      "detail-type": "UserSignUp",
      source: "my.event",
      account: "601427279990",
      time: "2022-01-24T16:00:10Z",
      region: "eu-west-1",
      resources: [],
      detail: {
        hello: "there",
        _datadog: {
          "x-datadog-trace-id": "5827606813695714842",
          "x-datadog-parent-id": "4726693487091824375",
          "x-datadog-sampled": "1",
          "x-datadog-sampling-priority": "1",
        },
      },
    });

    expect(result).toEqual({
      parentID: "4726693487091824375",
      sampleMode: 1,
      source: "event",
      traceID: "5827606813695714842",
    });
  });

  it("can read context from Kinesis messages", () => {
    const result = readTraceFromEvent({
      Records: [
        {
          kinesis: {
            kinesisSchemaVersion: "1.0",
            partitionKey: "cdbfd750-cec0-4f0f-a4b0-82ae6152c7fb",
            sequenceNumber: "49625698045709644136382874226371117765484751339579768834",
            data: "eyJJJ20gbWFkZSBvZiB3YXgsIExhcnJ5IjoiV2hhdCBhcmUgeW91IG1hZGUgb2Y/IiwiX2RhdGFkb2ciOnsieC1kYXRhZG9nLXRyYWNlLWlkIjoiNjY3MzA5NTE0MjIxMDM1NTM4IiwieC1kYXRhZG9nLXBhcmVudC1pZCI6IjEzNTA3MzUwMzU0OTc4MTE4MjgiLCJ4LWRhdGFkb2ctc2FtcGxlZCI6IjEiLCJ4LWRhdGFkb2ctc2FtcGxpbmctcHJpb3JpdHkiOiIxIn19",
            approximateArrivalTimestamp: 1642518727.248,
          },
          eventSource: "aws:kinesis",
          eventID: "shardId-000000000000:49545115243490985018280067714973144582180062593244200961",
          invokeIdentityArn: "arn:aws:iam::EXAMPLE",
          eventVersion: "1.0",
          eventName: "aws:kinesis:record",
          eventSourceARN: "arn:aws:kinesis:EXAMPLE",
          awsRegion: "us-east-1",
        },
      ],
    });
    expect(result).toEqual({
      parentID: "1350735035497811828",
      sampleMode: 1,
      source: "event",
      traceID: "667309514221035538",
    });
  });

  it("can read well formed headers with mixed casing", () => {
    const result = readTraceFromEvent({
      headers: {
        "X-Datadog-Parent-Id": "797643193680388254",
        "X-Datadog-Sampling-Priority": "2",
        "X-Datadog-Trace-Id": "4110911582297405557",
      },
    });
    expect(result).toEqual({
      parentID: "797643193680388254",
      sampleMode: SampleMode.USER_KEEP,
      traceID: "4110911582297405557",
      source: Source.Event,
    });
  });
  it("returns undefined when missing trace id", () => {
    const result = readTraceFromEvent({
      headers: {
        "x-datadog-parent-id": "797643193680388254",
        "x-datadog-sampling-priority": "2",
      },
    });
    expect(result).toBeUndefined();
  });
  it("returns undefined when missing parent id", () => {
    const result = readTraceFromEvent({
      headers: {
        "x-datadog-sampling-priority": "2",
        "x-datadog-trace-id": "4110911582297405557",
      },
    });
    expect(result).toBeUndefined();
  });
  it("returns undefined when missing sampling priority id", () => {
    const result = readTraceFromEvent({
      headers: {
        "x-datadog-parent-id": "797643193680388254",
        "x-datadog-trace-id": "4110911582297405557",
      },
    });
    expect(result).toBeUndefined();
  });
  it("returns undefined when missing headers value", () => {
    const result = readTraceFromEvent({});
    expect(result).toBeUndefined();
  });
  it("returns undefined when headers is null", () => {
    const result = readTraceFromEvent("some-value");
    expect(result).toBeUndefined();
  });
  it("returns undefined when event isn't object", () => {
    const result = readTraceFromEvent("some-value");
    expect(result).toBeUndefined();
  });
});