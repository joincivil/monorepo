import { NetworkContext, Node as NodeTypes } from "@counterfactual/types";
import { BaseProvider } from "ethers/providers";
import { SigningKey } from "ethers/utils";
import { HDNode } from "ethers/utils/hdnode";
import EventEmitter from "eventemitter3";
import log from "loglevel";
import { Memoize } from "typescript-memoize";

import { createRpcRouter } from "./api";
import AutoNonceWallet from "./auto-nonce-wallet";
import { Deferred } from "./deferred";
import { Opcode, Protocol, ProtocolMessage, ProtocolRunner } from "./machine";
import { FinMessage } from "./machine/types";
import { StateChannel } from "./models";
import { getFreeBalanceAddress } from "./models/free-balance";
import {
  EthereumNetworkName,
  getNetworkContextForNetworkName
} from "./network-configuration";
import ProcessQueue from "./process-queue";
import { RequestHandler } from "./request-handler";
import RpcRouter from "./rpc-router";
import { getHDNode } from "./signer";
import {
  NODE_EVENTS,
  NodeMessageWrappedFinMessage,
  NodeMessageWrappedProtocolMessage
} from "./types";
import { timeout } from "./utils";

export interface NodeConfig {
  // The prefix for any keys used in the store by this Node depends on the
  // execution environment.
  STORE_KEY_PREFIX: string;
}

const REASONABLE_NUM_BLOCKS_TO_WAIT = 1;

export class Node {
  private readonly incoming: EventEmitter;
  private readonly outgoing: EventEmitter;

  private readonly protocolRunner: ProtocolRunner;
  private readonly networkContext: NetworkContext;

  private readonly ioSendDeferrals = new Map<
    string,
    Deferred<NodeMessageWrappedProtocolMessage | NodeMessageWrappedFinMessage>
  >();

  /**
   * These properties don't have initializers in the constructor, since they must be initialized
   * asynchronously. This is done via the `asynchronouslySetupUsingRemoteServices` function.
   * Since we have a private constructor and only allow instances of the Node to be created
   * via `create` which immediately calls `asynchronouslySetupUsingRemoteServices`, these are
   * always non-null when the Node is being used.
   */
  private signer!: HDNode;
  protected requestHandler!: RequestHandler;
  public rpcRouter!: RpcRouter;

  static async create(
    messagingService: NodeTypes.IMessagingService,
    storeService: NodeTypes.IStoreService,
    nodeConfig: NodeConfig,
    provider: BaseProvider,
    networkOrNetworkContext: EthereumNetworkName | NetworkContext,
    lockService?: NodeTypes.ILockService,
    blocksNeededForConfirmation?: number
  ): Promise<Node> {
    const node = new Node(
      messagingService,
      storeService,
      nodeConfig,
      provider,
      networkOrNetworkContext,
      blocksNeededForConfirmation,
      lockService
    );

    return await node.asynchronouslySetupUsingRemoteServices();
  }

  private constructor(
    private readonly messagingService: NodeTypes.IMessagingService,
    private readonly storeService: NodeTypes.IStoreService,
    private readonly nodeConfig: NodeConfig,
    private readonly provider: BaseProvider,
    networkContext: EthereumNetworkName | NetworkContext,
    readonly blocksNeededForConfirmation: number = REASONABLE_NUM_BLOCKS_TO_WAIT,
    private readonly lockService?: NodeTypes.ILockService
  ) {
    this.incoming = new EventEmitter();
    this.outgoing = new EventEmitter();

    this.networkContext =
      typeof networkContext === "string"
        ? getNetworkContextForNetworkName(networkContext)
        : networkContext;

    this.protocolRunner = this.buildProtocolRunner();

    log.info(
      `Waiting for ${this.blocksNeededForConfirmation} block confirmations`
    );
  }

  private async asynchronouslySetupUsingRemoteServices(): Promise<Node> {
    this.signer = await getHDNode(this.storeService);
    log.info(`Node signer address: ${this.signer.address}`);
    log.info(`Node public identifier: ${this.publicIdentifier}`);
    this.requestHandler = new RequestHandler(
      this.publicIdentifier,
      this.incoming,
      this.outgoing,
      this.storeService,
      this.messagingService,
      this.protocolRunner,
      this.networkContext,
      this.provider,
      new AutoNonceWallet(this.signer.privateKey, this.provider),
      `${this.nodeConfig.STORE_KEY_PREFIX}/${this.publicIdentifier}`,
      this.blocksNeededForConfirmation!,
      new ProcessQueue(this.lockService)
    );
    this.registerMessagingConnection();
    this.rpcRouter = createRpcRouter(this.requestHandler);
    this.requestHandler.injectRouter(this.rpcRouter);

    return this;
  }

  @Memoize()
  get publicIdentifier(): string {
    return this.signer.neuter().extendedKey;
  }

  @Memoize()
  async signerAddress(): Promise<string> {
    return await this.requestHandler.getSignerAddress();
  }

  @Memoize()
  get freeBalanceAddress(): string {
    return getFreeBalanceAddress(this.publicIdentifier);
  }

  /**
   * Instantiates a new _ProtocolRunner_ object and attaches middleware
   * for the OP_SIGN, IO_SEND, and IO_SEND_AND_WAIT opcodes.
   */
  private buildProtocolRunner(): ProtocolRunner {
    const protocolRunner = new ProtocolRunner(
      this.networkContext,
      this.provider
    );

    protocolRunner.register(Opcode.OP_SIGN, async (args: any[]) => {
      if (args.length !== 1 && args.length !== 2) {
        throw Error("OP_SIGN middleware received wrong number of arguments.");
      }

      const [commitment, overrideKeyIndex] = args;
      const keyIndex = overrideKeyIndex || 0;

      const signingKey = new SigningKey(
        this.signer.derivePath(`${keyIndex}`).privateKey
      );

      return signingKey.signDigest(commitment.hashToSign());
    });

    protocolRunner.register(Opcode.IO_SEND_FIN, async (args: [FinMessage]) => {
      const [data] = args;
      const fromXpub = this.publicIdentifier;
      const to = data.toXpub;

      await this.messagingService.send(to, {
        data,
        from: fromXpub,
        type: NODE_EVENTS.PROTOCOL_MESSAGE_EVENT
      } as NodeMessageWrappedFinMessage);

      this.requestHandler.outgoing.emit(data.eventName, data);
    });

    protocolRunner.register(Opcode.IO_SEND, async (args: [ProtocolMessage]) => {
      const [data] = args;
      const fromXpub = this.publicIdentifier;
      const to = data.toXpub;

      await this.messagingService.send(to, {
        data,
        from: fromXpub,
        type: NODE_EVENTS.PROTOCOL_MESSAGE_EVENT
      } as NodeMessageWrappedProtocolMessage);
    });

    protocolRunner.register(
      Opcode.IO_SEND_AND_WAIT,
      async (args: [ProtocolMessage]) => {
        const [data] = args;
        const to = data.toXpub;

        const deferral = new Deferred<
          NodeMessageWrappedProtocolMessage | NodeMessageWrappedFinMessage
        >();

        this.ioSendDeferrals.set(data.processID, deferral);

        const counterpartyResponse = deferral.promise;

        await this.messagingService.send(to, {
          data,
          from: this.publicIdentifier,
          type: NODE_EVENTS.PROTOCOL_MESSAGE_EVENT
        } as NodeMessageWrappedProtocolMessage);

        const msg = await Promise.race([counterpartyResponse, timeout(60000)]);

        if (!msg || !("data" in (msg as NodeMessageWrappedProtocolMessage))) {
          throw Error(
            `IO_SEND_AND_WAIT timed out after 30s waiting for counterparty reply in ${data.protocol}`
          );
        }

        // Removes the deferral from the list of pending defferals after
        // its promise has been resolved and the necessary callback (above)
        // has been called. Note that, as is, only one defferal can be open
        // per counterparty at the moment.
        this.ioSendDeferrals.delete(data.processID);

        return (msg as NodeMessageWrappedProtocolMessage).data;
      }
    );

    protocolRunner.register(Opcode.WRITE_COMMITMENT, async (args: any[]) => {
      const { store } = this.requestHandler;

      const [protocol, commitment, ...key] = args;

      if (protocol === Protocol.Withdraw) {
        const [multisigAddress] = key;
        await store.storeWithdrawalCommitment(multisigAddress, commitment);
      } else {
        await store.setCommitment([protocol, ...key], commitment);
      }
    });

    protocolRunner.register(
      Opcode.PERSIST_STATE_CHANNEL,
      async (args: [StateChannel[]]) => {
        const { store } = this.requestHandler;
        const [stateChannels] = args;

        for (const stateChannel of stateChannels) {
          await store.saveStateChannel(stateChannel);
        }
      }
    );

    protocolRunner.register(Opcode.IO_WAIT, async (args: [FinMessage]) => {
      const [data] = args;

      const deferral = new Deferred<
        NodeMessageWrappedFinMessage | NodeMessageWrappedProtocolMessage
      >();

      this.ioSendDeferrals.set(data.processID, deferral);

      const counterpartyResponse = deferral.promise;

      const msg = (await Promise.race([
        counterpartyResponse,
        timeout(60000)
      ])) as NodeMessageWrappedFinMessage;

      if (!msg || !("data" in (msg as NodeMessageWrappedFinMessage))) {
        throw Error(
          `IO_WAIT timed out after 30s waiting for counterparty reply in ${data.eventName}`
        );
      }
      // Removes the deferral from the list of pending defferals after
      // its promise has been resolved and the necessary callback (above)
      // has been called. Note that, as is, only one defferal can be open
      // per counterparty at the moment.
      this.ioSendDeferrals.delete(data.processID);

      this.requestHandler.outgoing.emit(data.eventName, msg.data);

      return msg as NodeMessageWrappedFinMessage;
    });

    return protocolRunner;
  }

  /**
   * This is the entrypoint to listening for messages from other Nodes.
   * Delegates setting up a listener to the Node's outgoing EventEmitter.
   * @param event
   * @param callback
   */
  on(event: string, callback: (res: any) => void) {
    this.rpcRouter.subscribe(event, async (res: any) => callback(res));
  }

  /**
   * Stops listening for a given message from other Nodes. If no callback is passed,
   * all callbacks are removed.
   *
   * @param event
   * @param [callback]
   */
  off(event: string, callback?: (res: any) => void) {
    this.rpcRouter.unsubscribe(
      event,
      callback ? async (res: any) => callback(res) : undefined
    );
  }

  /**
   * This is the entrypoint to listening for messages from other Nodes.
   * Delegates setting up a listener to the Node's outgoing EventEmitter.
   * It'll run the callback *only* once.
   *
   * @param event
   * @param [callback]
   */
  once(event: string, callback: (res: any) => void) {
    this.rpcRouter.subscribeOnce(event, async (res: any) => callback(res));
  }

  /**
   * Delegates emitting events to the Node's incoming EventEmitter.
   * @param event
   * @param req
   */
  emit(event: string, req: NodeTypes.MethodRequest) {
    this.rpcRouter.emit(event, req);
  }

  /**
   * Makes a direct call to the Node for a specific method.
   * @param method
   * @param req
   */
  async call(
    method: NodeTypes.MethodName,
    req: NodeTypes.MethodRequest
  ): Promise<NodeTypes.MethodResponse> {
    return this.requestHandler.callMethod(method, req);
  }

  /**
   * When a Node is first instantiated, it establishes a connection
   * with the messaging service. When it receives a message, it emits
   * the message to its registered subscribers, usually external
   * subscribed (i.e. consumers of the Node).
   */
  private registerMessagingConnection() {
    this.messagingService.onReceive(
      this.publicIdentifier,
      async (msg: NodeTypes.NodeMessage) => {
        await this.handleReceivedMessage(msg);
        this.rpcRouter.emit(msg.type, msg, "outgoing");
      }
    );
  }

  /**
   * Messages received by the Node fit into one of three categories:
   *
   * (a) A NodeMessage which is _not_ a NodeMessageWrappedProtocolMessage;
   *     this is a standard received message which is handled by a named
   *     controller in the _events_ folder.
   *
   * (b) A NodeMessage which is a NodeMessageWrappedProtocolMessage _and_
   *     has no registered _ioSendDeferral_ callback. In this case, it means
   *     it will be sent to the protocol message event controller to dispatch
   *     the received message to the instruction executor.
   *
   * (c) A NodeMessage which is a NodeMessageWrappedProtocolMessage _and_
   *     _does have_ an _ioSendDeferral_, in which case the message is dispatched
   *     solely to the deffered promise's resolve callback.
   */
  private async handleReceivedMessage(msg: NodeTypes.NodeMessage) {
    if (!Object.values(NODE_EVENTS).includes(msg.type)) {
      console.error(`Received message with unknown event type: ${msg.type}`);
    }

    const isProtocolMessage = (msg: NodeTypes.NodeMessage) =>
      msg.type === NODE_EVENTS.PROTOCOL_MESSAGE_EVENT;

    const isFinishedMessage = (msg: NodeTypes.NodeMessage) =>
      msg.type.endsWith("FinishedEvent");

    const isExpectingResponse = (
      msg: NodeMessageWrappedProtocolMessage | NodeMessageWrappedFinMessage
    ) => this.ioSendDeferrals.has(msg.data.processID);

    if (
      (isProtocolMessage(msg) || isFinishedMessage(msg)) &&
      isExpectingResponse(msg as NodeMessageWrappedProtocolMessage)
    ) {
      await this.handleIoSendDeferral(msg as NodeMessageWrappedProtocolMessage);
    } else if (this.requestHandler.isLegacyEvent(msg.type)) {
      await this.requestHandler.callEvent(msg.type, msg);
    } else {
      await this.rpcRouter.emit(msg.type, msg);
    }
  }

  private async handleIoSendDeferral(msg: NodeMessageWrappedProtocolMessage) {
    const key = msg.data.processID;

    if (!this.ioSendDeferrals.has(key)) {
      throw Error(
        "Node received message intended for machine but no handler was present"
      );
    }

    const promise = this.ioSendDeferrals.get(key)!;

    try {
      promise.resolve(msg);
    } catch (error) {
      console.error(
        `Error while executing callback registered by IO_SEND_AND_WAIT middleware hook`,
        { error, msg }
      );
    }
  }
}
