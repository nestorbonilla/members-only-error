/** @jsxImportSource frog/jsx */

import { Button, FrameContext, Frog, TextInput } from 'frog';
import { Box, Heading, Text, VStack, Spacer, vars } from '@/app/utils/frog/ui';
import { devtools } from 'frog/dev';
import { neynar, type NeynarVariables } from 'frog/middlewares';
import { handle } from 'frog/next';
import { serveStatic } from 'frog/serve-static';
import neynarClient, { getEipChainId } from '@/app/utils/neynar/client';
import {
  ValidateFrameActionResponse,
} from '@neynar/nodejs-sdk/build/neynar-api/v2';
import {  erc20Abi, formatUnits } from 'viem';

import {
  doAddressesHaveValidMembershipInRules,
  getErc20Allowance,
  getErc20Decimals,
  getErc20Symbol,
  getFirstTokenIdOfOwner,
  getLockName,
  getLockPrice,
  getLockTokenAddress,
  getLockTotalKeys,
  getTokenExpiration,
} from '@/app/utils/viem/constants';
import { contracts } from '@unlock-protocol/contracts';
import { Context } from 'hono';

const app = new Frog({
  title: 'Members Only',
  assetsPath: '/',
  basePath: '/api',
  ui: { vars },
  origin: process.env.APP_URL,
  imageOptions: {
    format: 'png',
  },
  verify: process.env.NODE_ENV === 'production', // leave it as is, if not issue with frog local debug tool
});

const neynarMiddleware = neynar({
  apiKey: process.env.NEYNAR_API_KEY!,
  features: ['interactor', 'cast'],
});

// Uncomment to use Edge Runtime
// export const runtime = 'edge'

enum ApiRoute {
  HOOK_SETUP = 'HOOK-SETUP',
  HOOK_VALIDATE = 'HOOK-VALIDATE',
  FRAME_PURCHASE = 'FRAME-PURCHASE/:CHANNELID',
  FRAME_SETUP = 'FRAME-SETUP/:CHANNELID',
}

enum HookSetupResult {
  CAST_SUCCESS,
  CAST_ERROR,
  INVALID_AUTHOR,
  UNEXPECTED_ERROR,
  ROUTE_ERROR,
}

enum HookValidateResult {
  CAST_REACTION_SUCCESS,
  CAST_REACTION_ERROR,
  CAST_FRAME_SUCCESS,
  CAST_FRAME_ERROR,
  SETUP_TEXT,
  ROUTE_ERROR,
}

enum FrameSetupResult {
  FRAME_ACTION_VALID,
  FRAME_ACTION_INVALID,
  CAST_FRAME_SUCCESS,
  CAST_FRAME_ERROR,
  SETUP_TEXT,
  ROUTE_ERROR,
}

enum FramePurchaseResult {
  FRAME_ACTION_VALID,
  FRAME_ACTION_INVALID,
  CAST_FRAME_SUCCESS,
  CAST_FRAME_ERROR,
  SETUP_TEXT,
  ROUTE_ERROR,
  FRAME_MEMBERSHIP_VALID,
  FRAME_MEMBERSHIP_INVALID,
}

const statusMessage = {
  [ApiRoute.HOOK_SETUP]: {
    [HookSetupResult.CAST_SUCCESS]: `${ApiRoute.HOOK_SETUP} => CAST SENT SUCCESSFULLY`,
    [HookSetupResult.CAST_ERROR]: `${ApiRoute.HOOK_SETUP} => FAILED TO PUBLISH CAST`,
    [HookSetupResult.INVALID_AUTHOR]: `${ApiRoute.HOOK_SETUP} => CAST AUTHOR IS NOT CHANNEL OWNER`,
    [HookSetupResult.UNEXPECTED_ERROR]: `${ApiRoute.HOOK_SETUP} => POINT SHOULD NOT BE REACHED, CHECK NEYNAR HOOK`,
    [HookSetupResult.ROUTE_ERROR]: `${ApiRoute.HOOK_SETUP} => ROUTE ERROR`,
  },
  [ApiRoute.HOOK_VALIDATE]: {
    [HookValidateResult.CAST_REACTION_SUCCESS]: `${ApiRoute.HOOK_VALIDATE} => CAST REACTION SENT SUCCESSFULLY`,
    [HookValidateResult.CAST_REACTION_ERROR]: `${ApiRoute.HOOK_VALIDATE} => FAILED TO SEND CAST REACTION`,
    [HookValidateResult.CAST_FRAME_SUCCESS]: `${ApiRoute.HOOK_VALIDATE} => CAST AUTHOR IS NOT CHANNEL OWNER`,
    [HookValidateResult.CAST_FRAME_ERROR]: `${ApiRoute.HOOK_VALIDATE} => POINT SHOULD NOT BE REACHED, CHECK NEYNAR HOOK`,
    [HookValidateResult.SETUP_TEXT]: `${ApiRoute.HOOK_VALIDATE} => TEXT IS TO SETUP THE CHANNEL, NOT TO VALIDATE MEMBERSHIP`,
    [HookValidateResult.ROUTE_ERROR]: `${ApiRoute.HOOK_VALIDATE} => ROUTE ERROR`,
  },
  [ApiRoute.FRAME_SETUP]: {
    [FrameSetupResult.FRAME_ACTION_VALID]: `${ApiRoute.FRAME_SETUP} => FRAME ACTION IS VALID`,
    [FrameSetupResult.FRAME_ACTION_INVALID]: `${ApiRoute.FRAME_SETUP} => FRAME ACTION IS INVALID`,
  },
  [ApiRoute.FRAME_PURCHASE]: {
    [FramePurchaseResult.FRAME_ACTION_VALID]: `${ApiRoute.FRAME_PURCHASE} => FRAME ACTION IS VALID`,
    [FramePurchaseResult.FRAME_ACTION_INVALID]: `${ApiRoute.FRAME_PURCHASE} => FRAME ACTION IS INVALID`,
    [FramePurchaseResult.FRAME_MEMBERSHIP_VALID]: `${ApiRoute.FRAME_PURCHASE} => UNLOCK MEMBERSHIP IS VALID`,
    [FramePurchaseResult.FRAME_MEMBERSHIP_INVALID]: `${ApiRoute.FRAME_PURCHASE} => UNLOCK MEMBERSHIP IS INVALID`,
  },
};


app.frame(
  '/frame-purchase/:channelId',
  neynarMiddleware,
  async (c: FrameContext) => {
    const { buttonValue, status, req } = c;
    let ethAddresses: string[] = [];
    let channelId = req.param('channelId');
    let textFrame = '';
    let dynamicIntents: any[] = [];
    let totalKeysCount = 0;
    let erc20Allowance = BigInt(0);
    let lockTokenSymbol = '';
    let lockTokenDecimals = 18; // most ERC20 tokens have 18 decimals
    let lockTokenPriceVisual = '';

    // Get the channel access rules
    let channelRules = [
      {
        id: 52,
        channel_id: 'ouvre-boite',
        network: 'base',
        contract_address: '0xba6beb73cdaec34957290cb7e3522187f8382b55'
      }
    ];
    textFrame = `This channel requires membership(s). To purchase or renew one, let's verify some details.`;
    if (
      status == 'initial' ||
      (status == 'response' && buttonValue == 'done')
    ) {
      // Step 1: Show the number of rules on the channel
      dynamicIntents = [<Button value="verify">go</Button>];
    } else if (status == 'response') {
      console.log('accesing response');
      const payload = await req.json();
      if (process.env.NODE_ENV === 'production') {
        const frameActionResponse: ValidateFrameActionResponse =
          await neynarClient.validateFrameAction(
            payload.trustedData.messageBytes
          );
        if (frameActionResponse.valid) {
          ethAddresses =
            frameActionResponse.action.interactor.verified_addresses
              .eth_addresses;
          console.log(
            statusMessage[ApiRoute.FRAME_PURCHASE][
              FramePurchaseResult.FRAME_ACTION_VALID
            ]
          );
        } else {
          console.log(
            statusMessage[ApiRoute.FRAME_PURCHASE][
              FramePurchaseResult.FRAME_ACTION_INVALID
            ]
          );
        }
      } else {
        // For local development only
        ethAddresses = [process.env.APP_TEST_ADDRESS!];
      }
      if (ethAddresses.length > 0) {
        const prevBtn = (index: number) => {
          if (channelRules.length > 0 && index > 0) {
            return <Button value={`page-${index - 1}`}>prev</Button>;
          }
        };
        const nextBtn = (index: number) => {
          if (channelRules.length > index + 1) {
            return <Button value={`page-${index + 1}`}>next</Button>;
          }
        };
        if (buttonValue == 'verify' || buttonValue?.startsWith('page-')) {
          let tokenId: number | null = null;
          let userAddress: string | null = null;

          if (channelRules.length > 0) {
            let currentRule: any;
            let currentPage = 0;
            if (buttonValue == 'verify') {
              currentRule = channelRules[0];
            } else if (buttonValue?.startsWith('page-')) {
              let [_, page] = buttonValue!.split('-');
              currentPage = parseInt(page);
              currentRule = channelRules[currentPage];
            }
            // Verify the user doesn't have a valid membership the first rule
            let lockName = await getLockName(
              currentRule.contract_address,
              currentRule.network
            );
            let lockPrice = await getLockPrice(
              currentRule.contract_address,
              currentRule.network
            );
            let membershipIsValidForAtLeastOneAddress =
              await doAddressesHaveValidMembershipInRules(ethAddresses, [
                currentRule,
              ]);
            let keyCounts = await Promise.all(
              ethAddresses.map((ethAddress) =>
                getLockTotalKeys(
                  ethAddress,
                  currentRule.contract_address,
                  currentRule.network
                )
              )
            );
            let totalKeysCount = keyCounts.reduce(
              (sum, count) => sum + Number(count),
              0
            );
            let tokenInfo = await getFirstTokenIdOfOwner(
              ethAddresses,
              totalKeysCount,
              currentRule.contract_address,
              currentRule.network
            );
            let lockTokenAddress = await getLockTokenAddress(
              currentRule.contract_address,
              currentRule.network
            );
            if (lockTokenAddress == process.env.ZERO_ADDRESS) {
              // if the token address is zero address, then it's ether
              lockTokenSymbol = 'ETH';
              erc20Allowance = lockPrice; // txs with ETH don't need approval
            } else {
              lockTokenSymbol = await getErc20Symbol(
                lockTokenAddress,
                currentRule.network
              );
              lockTokenDecimals = await getErc20Decimals(
                lockTokenAddress,
                currentRule.network
              );
              erc20Allowance = await getErc20Allowance(
                ethAddresses[0],
                lockTokenAddress,
                currentRule.contract_address,
                currentRule.network
              );
            }
            lockTokenPriceVisual = formatUnits(lockPrice, lockTokenDecimals);
            // is membership renewable or allowed to buy a new one?
            // if yes, then show the 'increase allowance' button
            if (membershipIsValidForAtLeastOneAddress && tokenInfo) {
              console.log(
                statusMessage[ApiRoute.FRAME_PURCHASE][
                  FramePurchaseResult.FRAME_MEMBERSHIP_VALID
                ]
              );
              ({ tokenId, userAddress } = tokenInfo);
              // if membership is valid, then if it's renewable
              let keyExpirationInSeconds = await getTokenExpiration(
                tokenId,
                currentRule.contract_address,
                currentRule.network
              );
              const currentTimeMs = Date.now();
              const keyExpirationMiliseconds =
                Number(keyExpirationInSeconds) * 1000;
              const remainingTimeDays =
                (keyExpirationMiliseconds - currentTimeMs) /
                (1000 * 60 * 60 * 24); // Days remaining
              const showExpirationTime = remainingTimeDays <= 30; // Threshold of 30 days
              const options: Intl.DateTimeFormatOptions = {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
                hour: 'numeric',
                minute: 'numeric',
                second: 'numeric',
                timeZoneName: 'short', // Optional: Show timezone
              };
              let keyExpirationDate = new Date(keyExpirationMiliseconds);
              let keyExpirationString = keyExpirationDate.toLocaleString(
                undefined,
                options
              );
              textFrame = showExpirationTime
                ? ` You own a valid membership for "${lockName}", deployed on ${currentRule.network} network, and is valid til ${keyExpirationString}`
                : ` You own a valid membership for "${lockName}", deployed on ${currentRule.network} network.`;
              dynamicIntents = [
                <Button value="done">complete</Button>,
                prevBtn(currentPage),
                nextBtn(currentPage),
              ].filter(intent => !!intent);
            } else {
              console.log(
                statusMessage[ApiRoute.FRAME_PURCHASE][
                  FramePurchaseResult.FRAME_MEMBERSHIP_INVALID
                ]
              );
              textFrame = ` You don't own a valid membership for the lock "${lockName}", deployed on ${currentRule.network} network. It costs ${lockTokenPriceVisual} ${lockTokenSymbol} to purchase a key.`;
              
              const allowBtn = () => {
                if (erc20Allowance < lockPrice) {
                  return (
                    <Button value={'approval-0'}>increase allowance</Button>
                  );
                }
              };

              const buyBtn = () => {
                if (
                  erc20Allowance >= lockPrice &&
                  totalKeysCount == 0 &&
                  (!tokenInfo || tokenInfo.tokenId === 0) // Check if tokenInfo is null OR tokenId is 0
                ) {
                  return (
                    <Button.Transaction
                      target={`/tx-purchase/${currentRule.network}/${currentRule.contract_address}/${lockTokenSymbol}/${ethAddresses[0]}`}
                    >
                      buy
                    </Button.Transaction>
                  );
                }
              };

              const renewBtn = () => {
                if (
                  erc20Allowance >= lockPrice &&
                  totalKeysCount > 0 &&
                  tokenInfo?.tokenId &&
                  tokenInfo.tokenId > 0 // Explicit check for tokenId > 0
                ) {
                  const tokenIdForRenewal = tokenInfo?.tokenId;
                  // Before renewing the key, let's verify if it is renewable
                  let isRenewable = !tokenInfo?.isValid;
                  if (isRenewable) {
                    // One or more keys are expired, so let's renew the first we found
                    return (
                      <Button.Transaction
                        target={`/tx-renew/${currentRule.network}/${currentRule.contract_address}/${tokenIdForRenewal}/${lockPrice}`}
                      >
                        renew
                      </Button.Transaction>
                    );
                  }
                }
              };

              dynamicIntents = [
                prevBtn(currentPage),
                nextBtn(currentPage),
                allowBtn(),
                buyBtn(),
                renewBtn(),
              ].filter(intent => !!intent);
            }
          } else {
            textFrame = `It seems there are no rules currently to purchase for this channel.`;
            dynamicIntents = [
              <Button value="verify">complete</Button>
            ].filter(intent => !!intent);
          }
        } else if (buttonValue?.startsWith('approval-')) {
          textFrame = 'Do you want to approve one time (default), or multiple times? (set a number higher than 1)';
          let [_, page] = buttonValue!.split('-');
          let currentPage = parseInt(page);
          let currentRule = channelRules[currentPage];
          let lockTokenAddress = await getLockTokenAddress(
            currentRule.contract_address,
            currentRule.network
          );
          let lockPrice = await getLockPrice(
            currentRule.contract_address,
            currentRule.network
          );
          dynamicIntents = [
            <TextInput placeholder="amount..." />,
            <Button.Transaction
              target={`/tx-approval/${currentRule.network}/${currentRule.contract_address}/${lockTokenAddress}/${lockPrice}`}
            >
              approve
            </Button.Transaction>,
          ].filter(intent => !!intent);
        } else if (buttonValue == '_t') {
          textFrame = `Transaction sent! It's on its way to the blockchain. Just a short wait, then click "continue."`;
          dynamicIntents = [
            <Button value="done">continue</Button>
          ].filter(intent => !!intent);
        }
      } else {
        textFrame = `No verified Ethereum address found. Please verify at least one address to continue.`;
      }
    }
    return c.res({
      title: 'Members Only - Membership Purchase',
      image: (
        <Box
          grow
          alignHorizontal="center"
          backgroundColor="background"
          padding="32"
          borderStyle="solid"
          borderRadius="8"
          borderWidth="4"
          borderColor="yellow"
        >
          <VStack gap="4">
            <Heading color={'black'}>@membersonly user</Heading>
            <Spacer size="20" />
            <Text color={'black'} size="20">
              Channel: {channelId}
            </Text>
            <Spacer size="10" />
            <Text color={'black'} size="18">
              {textFrame}
            </Text>
          </VStack>
        </Box>
      ),
      intents: dynamicIntents,
    });
  }
);

app.transaction(
  '/tx-approval/:network/:lockAddress/:lockTokenAddress/:lockPrice',
  async (c) => {
    const { inputText, req } = c;
    let network = req.param('network');
    let lockAddress = req.param('lockAddress');
    let lockTokenAddress = req.param('lockTokenAddress');
    let lockPrice = req.param('lockPrice');
    let paramLockTokenAddress = lockTokenAddress as `0x${string}`;
    let paramLockAddress = lockAddress as `0x${string}`;
    type EipChainId = 'eip155:8453' | 'eip155:10' | 'eip155:42161';
    let paramChainId: EipChainId = getEipChainId(network);
    let customTimes = parseInt(inputText!);
    let price =
      customTimes > 1
        ? BigInt(customTimes) * BigInt(lockPrice)
        : BigInt(lockPrice);

    return c.contract({
      abi: erc20Abi,
      chainId: paramChainId,
      functionName: 'approve',
      args: [
        paramLockAddress, // spender address
        price, // amount uint256
      ],
      to: paramLockTokenAddress,
    });
  }
);

app.transaction(
  '/tx-purchase/:network/:lockAddress/:lockTokenSymbol/:userAddress',
  async (c) => {
    const { req } = c;
    let network = req.param('network');
    let lockAddress = req.param('lockAddress');
    let lockTokenSymbol = req.param('lockTokenSymbol');
    let userAddress = req.param('userAddress');
    let lockPrice = await getLockPrice(lockAddress, network);

    let paramLockAddress = lockAddress as `0x${string}`;
    let paramUserAddress = userAddress as `0x${string}`;
    let paramMOAddress = process.env.MO_ADDRESS as `0x${string}`;
    let paramLockPrice = BigInt(lockPrice);
    type EipChainId = 'eip155:8453' | 'eip155:10' | 'eip155:42161';
    let paramChainId: EipChainId = getEipChainId(network);
    console.log(
      `About to buy/renew a key for lock ${paramLockAddress} on ${paramChainId} network for ${lockPrice} ${lockTokenSymbol} from address ${userAddress}.`
    );

    if (lockTokenSymbol == 'ETH') {
      return c.contract({
        abi: contracts.PublicLockV14.abi,
        chainId: paramChainId,
        functionName: 'purchase',
        args: [
          [paramLockPrice], // _values uint256[]
          [paramUserAddress], // _recipients address[]
          [paramMOAddress], // _referrers address[]
          [paramUserAddress], // _keyManagers address[]
          [''], // _data bytes[]
        ],
        to: paramLockAddress,
        value: paramLockPrice,
      });
    } else {
      return c.contract({
        abi: contracts.PublicLockV14.abi,
        chainId: paramChainId,
        functionName: 'purchase',
        args: [
          [paramLockPrice], // _values uint256[]
          [paramUserAddress], // _recipients address[]
          [paramMOAddress], // _referrers address[]
          [paramUserAddress], // _keyManagers address[]
          [''], // _data bytes[]
        ],
        to: paramLockAddress,
      });
    }
  }
);

app.transaction('/tx-renew/:network/:lockAddress/:tokenId/:price', (c) => {
  const { req } = c;
  let network = req.param('network');
  let lockAddress = req.param('lockAddress');
  let tokenId = req.param('tokenId');
  let price = req.param('price');

  let paramLockAddress = lockAddress as `0x${string}`;
  let paramMOAddress = process.env.MO_ADDRESS as `0x${string}`;
  type EipChainId = 'eip155:8453' | 'eip155:10' | 'eip155:42161';
  let paramChainId: EipChainId = getEipChainId(network);
  let paramLockAbi = contracts.PublicLockV14.abi;
  let paramPrice = BigInt(price);

  return c.contract({
    abi: paramLockAbi,
    chainId: paramChainId,
    functionName: 'extend',
    args: [
      paramPrice, // _values uint256
      tokenId, // _tokenId uint256
      paramMOAddress, // _referrer address
      '', // _data bytes
    ],
    to: paramLockAddress,
  });
});

//_______________________________________________________________________________________________________________________
// Utils

devtools(app, { serveStatic });

export const GET = handle(app);
export const POST = handle(app);
