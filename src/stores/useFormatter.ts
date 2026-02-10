import { defineStore } from 'pinia';
import { useBlockchain } from './useBlockchain';
import numeral from 'numeral';
import dayjs from 'dayjs';
import duration from 'dayjs/plugin/duration';
import relativeTime from 'dayjs/plugin/relativeTime';
import updateLocale from 'dayjs/plugin/updateLocale';
import utc from 'dayjs/plugin/utc';
import localeData from 'dayjs/plugin/localeData';
import { useStakingStore } from './useStakingStore';
import { fromBase64, fromBech32, fromHex, toHex } from '@cosmjs/encoding';
import { consensusPubkeyToHexAddress, get } from '@/libs';
import { useBankStore } from './useBankStore';
import type { Coin, DenomTrace } from '@/types';
import { useDashboard } from './useDashboard';
import type { Asset } from '@ping-pub/chain-registry-client/dist/types'
import { MsgExec } from 'cosmjs-types/cosmos/authz/v1beta1/tx';

dayjs.extend(localeData);
dayjs.extend(duration);
dayjs.extend(relativeTime);
dayjs.extend(updateLocale);
dayjs.extend(utc);
dayjs.updateLocale('en', {
  relativeTime: {
    future: 'in %s',
    past: '%s ago',
    s: '%ds',
    m: '1m',
    mm: '%dm',
    h: 'an hour',
    hh: '%d hours',
    d: 'a day',
    dd: '%d days',
    M: 'a month',
    MM: '%d months',
    y: 'a year',
    yy: '%d years',
  },
});

export const useFormatter = defineStore('formatter', {
  state: () => {
    return {
      ibcDenoms: {} as Record<string, DenomTrace>,
      ibcMetadata: {} as Record<string, Asset>,
      loading: [] as string[],
    };
  },
  getters: {
    blockchain() {
      return useBlockchain();
    },
    staking() {
      return useStakingStore();
    },
    useBank() {
      return useBankStore();
    },
    dashboard() {
      return useDashboard();
    },
  },
  actions: {
    async fetchDenomTrace(denom: string) {
      const hash = denom.replace('ibc/', '');
      let trace = this.ibcDenoms[hash];
      if (!trace) {
        trace = (await this.blockchain.rpc.getIBCAppTransferDenom(hash))
          .denom_trace;
        this.ibcDenoms[hash] = trace;
      }
      return trace;
    },
    async fetchDenomMetadata(denom: string) {
      if (this.loading.includes(denom)) return
      this.loading.push(denom)
      try {
        const hash = denom.startsWith("ibc/") ? denom.replace(/^ibc\//, "") : denom;
        const url = `${this.blockchain.endpoint.address}/cosmos/bank/v1beta1/denoms_metadata/ibc/${hash}`;
        const data = await get(url) as { metadata: Asset };
        if (data && data.metadata) {
          this.ibcMetadata[hash] = data.metadata;
        }
      } catch (e) {
        console.error(`Failed to fetch metadata for ${denom}`, e)
      } finally {
        this.loading = this.loading.filter(x => x !== denom)
      }
    },
    async resolveIBCChainId(denom: string, trace: DenomTrace) {
      if (!trace || !trace.path) return;
      const parts = trace.path.split('/');
      // Standard path: transfer/channel-X
      if (parts.length >= 2 && parts[0] === 'transfer' && parts[1].startsWith('channel-')) {
        const port = parts[0];
        const channelId = parts[1];
        const cacheKey = `${channelId}`;


        // Check if already resolved/cached (in a real app, use a proper cache)
        if ((this as any)._ibcChainIdCache?.[cacheKey]) return (this as any)._ibcChainIdCache[cacheKey];

        try {
          // 1. Get Channel
          const channelRes = await this.blockchain.rpc.getIBCChannel(channelId, port);
          const connectionId = channelRes?.channel?.connection_hops?.[0];
          if (!connectionId) return;

          // 2. Get Connection for State
          const connRes = await this.blockchain.rpc.getIBCConnectionsById(connectionId);
          const state = connRes?.connection?.state; // e.g. "STATE_OPEN"

          // 3. Get Client State for Chain ID
          const clientStateRes = await this.blockchain.rpc.getIBCConnectionsClientState(connectionId);
          const chainId = clientStateRes?.identified_client_state?.client_state?.chain_id;

          if (chainId) {
            const result = { chainId, state };
            if (!(this as any)._ibcChainIdCache) (this as any)._ibcChainIdCache = {};
            (this as any)._ibcChainIdCache[cacheKey] = result;
            return result;
          }
        } catch (e) {
          console.error('Failed to resolve IBC chain ID', e);
        }
      }
    },
    priceInfo(denom: string) {
      const id = this.dashboard.coingecko[denom]?.coinId || "";
      const prices = this.dashboard.prices[id];
      return prices;
    },
    color(change?: number) {
      if (!change) return ""
      switch (true) {
        case change > 0:
          return "text-success"
        case change < 0:
          return "text-error"
        default:
          return ""
      }
    },
    priceColor(denom: string, currency = "usd") {
      const change = this.priceChanges(denom, currency)
      return this.color(change)
    },
    price(denom: string, currency = "usd") {
      if (!denom || denom.length < 2) return 0
      const info = this.priceInfo(denom);
      return info ? info[currency] || 0 : 0;
    },
    priceChanges(denom: string, currency = 'usd'): number {
      const info = this.priceInfo(denom);
      return info ? info[`${currency}_24h_change`] || 0 : 0;
    },
    showChanges(v?: number) {
      return v !== 0 ? numeral(v).format("+0,0") : ""
    },
    tokenValue(token?: Coin) {
      if (token) {
        return numeral(this.tokenValueNumber(token)).format("0,0.[00]")
      }
      return ""
    },
    specialDenom(denom: string) {
      switch (true) {
        case denom.startsWith('u'): return 6
        case denom.startsWith("a"): return 18
        case denom === 'inj': return 18
      }
      return this.exponentForDenom(denom)
    },
    tokenAmountNumber(token?: Coin) {
      if (!token || !token.denom) return 0

      // find the symbol
      const symbol = this.dashboard.coingecko[token.denom]?.symbol || token.denom
      // convert denomination to symbol
      const exponent = this.dashboard.coingecko[symbol?.toLowerCase()]?.exponent || this.specialDenom(token.denom);
      // caculate amount of symbol
      const amount = Number(token.amount) / (10 ** exponent)
      return amount
    },
    tokenValueNumber(token?: Coin) {
      if (!token || !token.denom) return 0

      const amount = this.tokenAmountNumber(token)
      const value = amount * this.price(token.denom)
      return value
    },
    formatTokenAmount(token: { denom: string; amount: string }) {
      return this.formatToken(token, false);
    },
    formatToken2(token: { denom: string; amount: string }, withDenom = true) {
      return this.formatToken(token, true, '0,0.[00]');
    },

    findGlobalAssetConfig(denom: string) {
      const chains = Object.values(this.dashboard.chains)
      for (let i = 0; i < chains.length; i++) {
        const assets = chains[i].assets
        const conf = assets.find(a => a.base === denom)
        if (conf) {
          return conf
        }
      }
      return undefined
    },
    exponentForDenom(denom: string) {
      const asset: Asset | undefined = this.findGlobalAssetConfig(denom)
      let exponent = 0;
      if (asset) {
        // find the max exponent for display
        asset.denom_units.forEach((x) => {
          if (x.exponent >= exponent) {
            exponent = x.exponent;
          }
        });
      }

      return exponent;
    },
    tokenDisplayDenom(denom?: string) {
      if (denom) {
        let asset: Asset | undefined;
        if (denom && denom.startsWith('ibc/')) {
          const ibcDenom = denom.replace('ibc/', '')
          asset = this.ibcMetadata[ibcDenom];
          if (!asset) {
            // update ibc metadata if not exits in local cache
            this.fetchDenomMetadata(ibcDenom)
          }
        } else {
          asset = this.findGlobalAssetConfig(denom)
        }

        if (asset) {
          let unit = { exponent: 0, denom: '' };
          // find the max exponent for display
          asset.denom_units.forEach((x) => {
            if (x.exponent >= unit.exponent) {
              unit = x;
            }
          });
          return unit.denom;
        }
        return denom;
      }
    },
    tokenDisplayNumber(
      token?: { denom: string; amount: string },
      mode = 'all'
    ) {
      if (token && token.amount && token?.denom) {
        let amount = Number(token.amount);
        let denom = token.denom;

        let conf = mode === 'local' ? this.blockchain.current?.assets?.find(
          // @ts-ignore
          (x) => x.base === token.denom || x.base.denom === token.denom
        ) : this.findGlobalAssetConfig(token.denom)

        if (denom && denom.startsWith('ibc/')) {
          conf = this.ibcMetadata[denom.replace('ibc/', '')];
          if (!conf) {
            this.fetchDenomMetadata(denom.replace('ibc/', ''))
          }
        }

        if (conf) {
          let unit = { exponent: 0, denom: '' };
          // find the max exponent for display
          conf.denom_units.forEach((x) => {
            if (x.exponent >= unit.exponent) {
              unit = x;
            }
          });
          if (unit && unit.exponent > 0) {
            amount = amount / Math.pow(10, unit.exponent || 6);
          }
        }
        return amount;
      }
      return 0;
    },
    formatToken(
      token?: { denom: string; amount: string },
      withDenom = true,
      fmt = '0,0.[0]',
      mode = 'local'
    ): string {
      if (token && token.amount && token?.denom) {
        let amount = Number(token.amount);
        let denom = token.denom;

        let conf = mode === 'local' ? this.blockchain.current?.assets?.find(
          // @ts-ignore
          (x) => x.base === token.denom || x.base.denom === token.denom
        ) : this.findGlobalAssetConfig(token.denom)

        if (denom && denom.startsWith('ibc/')) {
          conf = this.ibcMetadata[denom.replace('ibc/', '')];
          if (!conf) {
            this.fetchDenomMetadata(denom.replace('ibc/', ''))
          }
        }

        if (conf) {
          let unit = { exponent: 0, denom: '' };
          // find the max exponent for display
          conf.denom_units.forEach((x) => {
            if (x.exponent >= unit.exponent) {
              unit = x;
            }
          });
          if (unit && unit.exponent > 0) {
            amount = amount / Math.pow(10, unit.exponent || 6);
            denom = unit.denom; // keep display denom as defined (e.g., 'gonka')
          }
        }
        if (amount < 0.000001) {
          return `0 ${denom.substring(0, 10)}`;
        }
        if (amount < 0.01) {
          fmt = '0.[000000]'
        }
        return `${numeral(amount).format(fmt)} ${withDenom ? denom.substring(0, 10) : ''
          }`;
      }
      return '-';
    },
    formatTokens(
      tokens?: { denom: string; amount: string }[],
      withDenom = true,
      fmt = '0.0a'
    ): string {
      if (!tokens) return '';
      return tokens.map((x) => this.formatToken(x, withDenom, fmt)).join(', ');
    },
    calculateBondedRatio(
      pool: { bonded_tokens: string; not_bonded_tokens: string } | undefined
    ) {
      if (pool && pool.bonded_tokens) {
        const b = Number(pool.bonded_tokens);
        const nb = Number(pool.not_bonded_tokens);
        const p = b / (b + nb);
        return numeral(p).format('0.[00]%');
      }
      return '-';
    },
    validator(address: string) {
      if (!address) return address;

      const txt = toHex(fromBase64(address)).toUpperCase();
      const validator = this.staking.validators.find(
        (x) => consensusPubkeyToHexAddress(x.consensus_pubkey) === txt
      );
      return validator?.description?.moniker;
    },
    // find validator by operator address
    validatorFromBech32(address: string) {
      if (!address) return address;
      const validator = this.staking.validators.find(
        (x) => x.operator_address === address
      );
      return validator?.description?.moniker;
    },
    calculatePercent(input?: string | number, total?: string | number) {
      if (!input || !total) return '0';
      const percent = Number(input) / Number(total);
      return numeral(percent > 0.0001 ? percent : 0).format('0.[00]%');
    },
    formatDecimalToPercent(decimal: string) {
      return numeral(decimal).format('0.[00]%');
    },
    formatCommissionRate(rate?: string) {
      if (!rate) return '-';
      return this.percent(rate);
    },
    percent(decimal?: string | number) {
      return decimal ? numeral(decimal).format('0.[00]%') : '-';
    },
    formatNumber(input?: number, fmt = '0.[00]') {
      if (!input) return ""
      return numeral(input).format(fmt)
    },
    numberAndSign(input: number, fmt = '+0,0') {
      return numeral(input).format(fmt);
    },
    toLocaleDate(time?: string | number | Date) {
      if (!time) return ""
      return new Date(time).toLocaleString(navigator.language)
    },
    toDay(time?: string | number | Date, format = 'long') {
      if (!time) return '';
      if (format === 'long') {
        return dayjs(time).format('YYYY-MM-DD HH:mm');
      }
      if (format === 'date') {
        return dayjs(time).format('YYYY-MM-DD');
      }
      if (format === 'time') {
        return dayjs(time).format('HH:mm:ss');
      }
      if (format === 'from') {
        return dayjs(time).fromNow();
      }
      if (format === 'to') {
        return dayjs(time).toNow();
      }
      return dayjs(time).format('YYYY-MM-DD HH:mm:ss');
    },
    messages(msgs: { '@type'?: string; typeUrl?: string; value?: Uint8Array }[]) {
      if (msgs) {
        const formatMsgUrl = (url: string) => {
          return url.substring(url.lastIndexOf('.') + 1).replace('Msg', '');
        }
        const getMsgName = (msg: { '@type'?: string; typeUrl?: string; value?: Uint8Array }): string | string[] => {
          const typeUrl = msg['@type'] || msg.typeUrl || 'unknown';
          if (typeUrl === '/cosmos.authz.v1beta1.MsgExec' && msg.value) {
            try {
              // Manual decoding for MsgExec since we might not have the full registry in this context easily accessible
              // MsgExec structure: grantee (1), msgs (2) repeated Any
              // We can use a simple protobuf reader or just rely on the fact that we have the value.
              // To properly decode, we should use the registry if possible, but importing it here is fine.
              const decoded = MsgExec.decode(msg.value);
              if (decoded.msgs && decoded.msgs.length > 0) {
                return decoded.msgs.map((inner: any) => {
                  const innerName = getMsgName(inner);
                  return `${formatMsgUrl(typeUrl)} > ${Array.isArray(innerName) ? innerName.join(', ') : innerName}`;
                }).flat();
              }
            } catch (e) {
              // fallback if decoding fails
            }
          }
          return formatMsgUrl(typeUrl);
        };

        const sum: Record<string, number> = msgs
          .map((msg) => getMsgName(msg))
          .flat()
          .reduce((s, c) => {
            const sh: Record<string, number> = s;
            if (sh[c]) {
              sh[c] += 1;
            } else {
              sh[c] = 1;
            }
            return sh;
          }, {});
        const output: string[] = [];
        Object.keys(sum).forEach((k) => {
          output.push(sum[k] > 1 ? `${k}×${sum[k]}` : k);
        });
        return output.join(', ');
      }
    },
    multiLine(v: string) {
      return v ? v.replace(/\\n|\\r/g, '\n') : '';
    },
    hexToString(hex: string) {
      if (hex) {
        return new TextDecoder().decode(fromHex(hex));
      }
      return '';
    },
    base64ToString(hex: string) {
      if (hex) {
        return new TextDecoder().decode(fromBase64(hex));
      }
      return '';
    },
  },
});
