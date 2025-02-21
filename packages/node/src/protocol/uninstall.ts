import { Node } from "@counterfactual/types";
import { BaseProvider } from "ethers/providers";

import { SetStateCommitment } from "../ethereum";
import { Opcode, Protocol } from "../machine/enums";
import {
  Context,
  FinMessage,
  ProtocolExecutionFlow,
  ProtocolMessage,
  UninstallParams
} from "../machine/types";
import { xkeyKthAddress } from "../machine/xkeys";
import { StateChannel } from "../models";

import { computeTokenIndexedFreeBalanceIncrements } from "./utils/get-outcome-increments";
import { UNASSIGNED_SEQ_NO } from "./utils/signature-forwarder";
import { assertIsValidSignature } from "./utils/signature-validator";

const protocol = Protocol.Uninstall;
const {
  OP_SIGN,
  IO_SEND,
  IO_SEND_AND_WAIT,
  IO_SEND_FIN,
  IO_WAIT,
  PERSIST_STATE_CHANNEL,
  WRITE_COMMITMENT
} = Opcode;

/**
 * @description This exchange is described at the following URL:
 *
 * specs.counterfactual.com/06-uninstall-protocol#messages
 */
export const UNINSTALL_PROTOCOL: ProtocolExecutionFlow = {
  0 /* Initiating */: async function*(context: Context) {
    const { message, provider, stateChannelsMap, network } = context;
    const { params, processID } = message;
    const { responderXpub, appIdentityHash } = params as UninstallParams;

    const responderAddress = xkeyKthAddress(responderXpub, 0);

    const postProtocolStateChannel = await computeStateTransition(
      params as UninstallParams,
      stateChannelsMap,
      provider
    );

    const uninstallCommitment = new SetStateCommitment(
      network,
      postProtocolStateChannel.freeBalance.identity,
      postProtocolStateChannel.freeBalance.hashOfLatestState,
      postProtocolStateChannel.freeBalance.versionNumber,
      postProtocolStateChannel.freeBalance.timeout
    );

    const signature = yield [OP_SIGN, uninstallCommitment];

    const {
      customData: { signature: responderSignature }
    } = yield [
      IO_SEND_AND_WAIT,
      {
        protocol,
        processID,
        params,
        toXpub: responderXpub,
        customData: { signature },
        seq: 1
      } as ProtocolMessage
    ];

    assertIsValidSignature(
      responderAddress,
      uninstallCommitment,
      responderSignature
    );

    const finalCommitment = uninstallCommitment.getSignedTransaction([
      signature,
      responderSignature
    ]);

    yield [WRITE_COMMITMENT, protocol, finalCommitment, appIdentityHash];

    yield [PERSIST_STATE_CHANNEL, [postProtocolStateChannel]];

    context.stateChannelsMap.set(
      postProtocolStateChannel.multisigAddress,
      postProtocolStateChannel
    );

    yield [
      IO_SEND_FIN,
      {
        processID,
        toXpub: responderXpub,
        eventName: Node.EventName.UNINSTALL_FINISHED
      } as FinMessage
    ];
  },

  1 /* Responding */: async function*(context: Context) {
    const { message, provider, stateChannelsMap, network } = context;
    const { params, processID } = message;
    const { initiatorXpub, appIdentityHash } = params as UninstallParams;

    const initiatorAddress = xkeyKthAddress(initiatorXpub, 0);

    const postProtocolStateChannel = await computeStateTransition(
      params as UninstallParams,
      stateChannelsMap,
      provider
    );

    const uninstallCommitment = new SetStateCommitment(
      network,
      postProtocolStateChannel.freeBalance.identity,
      postProtocolStateChannel.freeBalance.hashOfLatestState,
      postProtocolStateChannel.freeBalance.versionNumber,
      postProtocolStateChannel.freeBalance.timeout
    );

    const initiatorSignature = context.message.customData.signature;

    assertIsValidSignature(
      initiatorAddress,
      uninstallCommitment,
      initiatorSignature
    );

    const responderSignature = yield [OP_SIGN, uninstallCommitment];

    const finalCommitment = uninstallCommitment.getSignedTransaction([
      responderSignature,
      initiatorSignature
    ]);

    yield [WRITE_COMMITMENT, protocol, finalCommitment, appIdentityHash];

    yield [PERSIST_STATE_CHANNEL, [postProtocolStateChannel]];

    yield [
      IO_SEND,
      {
        protocol,
        processID,
        toXpub: initiatorXpub,
        seq: UNASSIGNED_SEQ_NO,
        customData: {
          signature: responderSignature
        }
      } as ProtocolMessage
    ];

    context.stateChannelsMap.set(
      postProtocolStateChannel.multisigAddress,
      postProtocolStateChannel
    );

    yield [
      IO_WAIT,
      {
        processID,
        eventName: Node.EventName.UNINSTALL_FINISHED
      }
    ];
  }
};

async function computeStateTransition(
  params: UninstallParams,
  stateChannelsMap: Map<string, StateChannel>,
  provider: BaseProvider
) {
  const { appIdentityHash, multisigAddress } = params;
  const stateChannel = stateChannelsMap.get(multisigAddress) as StateChannel;
  return stateChannel.uninstallApp(
    appIdentityHash,
    await computeTokenIndexedFreeBalanceIncrements(
      stateChannel.getAppInstance(appIdentityHash),
      provider
    )
  );
}
