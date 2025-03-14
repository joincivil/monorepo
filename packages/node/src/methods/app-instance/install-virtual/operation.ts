import { AppInstanceProposal, Node } from "@counterfactual/types";

import { Protocol, ProtocolRunner } from "../../../machine";
import { Store } from "../../../store";
import {
  NO_APP_INSTANCE_ID_TO_INSTALL,
  VIRTUAL_APP_INSTALLATION_FAIL
} from "../../errors";

export async function installVirtual(
  store: Store,
  protocolRunner: ProtocolRunner,
  params: Node.InstallParams
): Promise<AppInstanceProposal> {
  const { appInstanceId } = params;

  if (!appInstanceId || !appInstanceId.trim()) {
    throw Error(NO_APP_INSTANCE_ID_TO_INSTALL);
  }

  const proposal = await store.getAppInstanceProposal(appInstanceId);

  const {
    abiEncodings,
    appDefinition,
    initialState,
    initiatorDeposit,
    initiatorDepositTokenAddress,
    intermediaryIdentifier,
    outcomeType,
    proposedByIdentifier,
    proposedToIdentifier,
    responderDeposit,
    responderDepositTokenAddress,
    timeout
  } = proposal;

  if (initiatorDepositTokenAddress !== responderDepositTokenAddress) {
    throw Error("Cannot install virtual app with different token addresses");
  }

  try {
    await protocolRunner.initiateProtocol(
      Protocol.InstallVirtualApp,
      await store.getStateChannelsMap(),
      {
        initialState,
        outcomeType,
        initiatorXpub: proposedToIdentifier,
        responderXpub: proposedByIdentifier,
        intermediaryXpub: intermediaryIdentifier!,
        defaultTimeout: timeout.toNumber(),
        appInterface: { addr: appDefinition, ...abiEncodings },
        appSeqNo: proposal.appSeqNo,
        initiatorBalanceDecrement: initiatorDeposit,
        responderBalanceDecrement: responderDeposit,
        tokenAddress: initiatorDepositTokenAddress
      }
    );
  } catch (e) {
    throw Error(
      // TODO: We should generalize this error handling style everywhere
      `Node Error: ${VIRTUAL_APP_INSTALLATION_FAIL}\nStack Trace: ${e.stack}`
    );
  }

  await store.saveRealizedProposedAppInstance(proposal);

  return proposal;
}
