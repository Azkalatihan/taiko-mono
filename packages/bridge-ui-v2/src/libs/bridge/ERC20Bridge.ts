import { getContract } from '@wagmi/core';

import { erc20ABI, tokenVaultABI } from '$abi';
import { bridge } from '$config';
import { InsufficientAllowanceError, NoAllowanceRequiredError } from '$libs/error';
import { getLogger } from '$libs/util/logger';

import type { ApproveArgs, Bridge, ERC20BridgeArgs, RequireAllowanceArgs, SendERC20Args } from './types';

const log = getLogger('ERC20Bridge');

export class ERC20Bridge implements Bridge {
  private static async _prepareTransaction(args: ERC20BridgeArgs) {
    const {
      to,
      amount,
      wallet,
      destChainId,
      tokenAddress,
      processingFee,
      tokenVaultAddress,
      isTokenAlreadyDeployed,
      memo = '',
    } = args;

    const tokenVaultContract = getContract({
      walletClient: wallet,
      abi: tokenVaultABI,
      address: tokenVaultAddress,
    });

    const refundAddress = wallet.account.address;

    const gasLimit = !isTokenAlreadyDeployed
      ? BigInt(bridge.noTokenDeployedGasLimit)
      : processingFee > 0
      ? bridge.noOwnerGasLimit
      : BigInt(0);

    const sendERC20Args: SendERC20Args = [
      BigInt(destChainId),
      to,
      tokenAddress,
      amount,
      gasLimit,
      processingFee,
      refundAddress,
      memo,
    ];

    log('Preparing transaction with args', sendERC20Args);

    return { tokenVaultContract, sendERC20Args };
  }

  async estimateGas(args: ERC20BridgeArgs) {
    const { tokenVaultContract, sendERC20Args } = await ERC20Bridge._prepareTransaction(args);
    const [, , , , , processingFee] = sendERC20Args;

    const value = processingFee;

    log('Estimating gas for sendERC20 call with value', value);

    const estimatedGas = tokenVaultContract.estimateGas.sendERC20([...sendERC20Args], { value });

    log('Gas estimated', estimatedGas);

    return estimatedGas;
  }

  async requireAllowance({ amount, tokenAddress, ownerAddress, spenderAddress }: RequireAllowanceArgs) {
    const tokenContract = getContract({
      abi: erc20ABI,
      address: tokenAddress,
    });

    log('Checking allowance for the amount', amount);

    const allowance = await tokenContract.read.allowance([ownerAddress, spenderAddress]);

    const requiresAllowance = allowance < amount;

    log('Allowance is', allowance, 'requires allowance?', requiresAllowance);

    return requiresAllowance;
  }

  async approve(args: ApproveArgs) {
    const { amount, tokenAddress, spenderAddress, wallet } = args;

    const requireAllowance = await this.requireAllowance({
      amount,
      tokenAddress,
      ownerAddress: wallet.account.address,
      spenderAddress,
    });

    if (!requireAllowance) {
      throw new NoAllowanceRequiredError(`no allowance required for the amount ${amount}`);
    }

    const tokenContract = getContract({
      walletClient: wallet,
      abi: erc20ABI,
      address: tokenAddress,
    });

    log(`Calling approve for spender "${spenderAddress}" with amount`, amount);

    const txHash = await tokenContract.write.approve([spenderAddress, amount]);

    log('Transaction hash for approve call', txHash);

    return txHash;
  }

  async bridge(args: ERC20BridgeArgs) {
    const { amount, tokenAddress, wallet, tokenVaultAddress } = args;

    const requireAllowance = await this.requireAllowance({
      amount,
      tokenAddress,
      ownerAddress: wallet.account.address,
      spenderAddress: tokenVaultAddress,
    });

    if (requireAllowance) {
      throw new InsufficientAllowanceError(`Insufficient allowance for the amount ${amount}`);
    }

    const { tokenVaultContract, sendERC20Args } = await ERC20Bridge._prepareTransaction(args);
    const [, , , , , processingFee] = sendERC20Args;

    const value = processingFee;

    log('Calling sendERC20 with value', value);

    const txHash = tokenVaultContract.write.sendERC20([...sendERC20Args], { value });

    log('Transaction hash for sendERC20 call', txHash);
  }
}
