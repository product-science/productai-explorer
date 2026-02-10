import { defineStore } from 'pinia';
import { useBlockchain } from '@/stores';
import { decodeTxRaw, type DecodedTxRaw } from '@cosmjs/proto-signing';
import dayjs from 'dayjs';
import type { Block } from '@/types';
import { hashTx } from '@/libs';
import { fromBase64 } from '@cosmjs/encoding';
import { useRouter } from 'vue-router';

export const useBaseStore = defineStore('baseStore', {
    state: () => {
        return {
            earlest: {} as Block,
            latest: {} as Block,
            recents: [] as Block[],
            theme: (window.localStorage.getItem('theme') || 'dark') as
                | 'light'
                | 'dark',
            connected: true,
            blockCache: {} as Record<string, { data: Block, txResponses?: any[], timestamp: number }>,
            txFilterState: { msgTypes: [], creators: [] } as { msgTypes: string[], creators: string[] },
        };
    },
    getters: {
        blocktime(): number {
            if (this.earlest && this.latest) {
                if (
                    this.latest.block?.header?.height !==
                    this.earlest.block?.header?.height
                ) {
                    const diff = dayjs(this.latest.block?.header?.time).diff(
                        this.earlest.block?.header?.time
                    );
                    const blocks = Number(this.latest.block.header.height) - Number(this.earlest.block.header.height)
                    return diff / (blocks);
                }
            }
            return 6000;
        },
        blockchain() {
            return useBlockchain();
        },
        currentChainId(): string {
            return this.latest.block?.header.chain_id || '';
        },
        txsInRecents() {
            const txs = [] as {
                height: string;
                hash: string;
                tx: DecodedTxRaw;
            }[];
            this.recents.forEach((b) =>
                b.block?.data?.txs.forEach((tx: string) => {
                    if (tx) {
                        const raw = fromBase64(tx);
                        try {
                            txs.push({
                                height: b.block.header.height,
                                hash: hashTx(raw),
                                tx: decodeTxRaw(raw),
                            });
                        } catch (e) {
                            console.error(e);
                        }
                    }
                })
            );
            return txs.sort((a, b) => { return Number(b.height) - Number(a.height) });
        },
    },
    actions: {
        async initial() {
            this.fetchLatest()
        },
        async clearRecentBlocks() {
            this.recents = [];
        },
        async fetchLatest() {
            try {
                this.latest = await this.blockchain.rpc?.getBaseBlockLatest();
                this.connected = true
            } catch (e) {
                this.connected = false
            }
            if (
                !this.earlest ||
                this.earlest?.block?.header?.chain_id !=
                this.latest?.block?.header?.chain_id
            ) {
                //reset earlest and recents
                this.earlest = this.latest;
                this.recents = [];
            }
            //check if the block exists in recents
            if (
                this.recents.findIndex(
                    (x) => x?.block_id?.hash === this.latest?.block_id?.hash
                ) === -1
            ) {
                if (this.recents.length >= 50) {
                    this.recents.shift();
                }
                this.recents.push(this.latest);
            }
            return this.latest;
        },

        async fetchValidatorByHeight(height?: number, offset = 0) {
            return this.blockchain.rpc.getBaseValidatorsetAt(
                String(height),
                offset
            );
        },
        async fetchLatestValidators(offset = 0) {
            return this.blockchain.rpc.getBaseValidatorsetLatest(offset);
        },
        async fetchBlock(height?: number | string) {
            const h = String(height);
            // Check cache (24 hours expiration)
            const cached = this.blockCache[h];
            if (cached && (Date.now() - cached.timestamp < 24 * 60 * 60 * 1000)) {
                return cached.data;
            }

            const data = await this.blockchain.rpc.getBaseBlockAt(h);
            if (data && data.block) {
                this.blockCache[h] = { data, timestamp: Date.now() };
            }
            return data;
        },
        getCachedTxResponses(height: string | number) {
            const h = String(height);
            const cached = this.blockCache[h];
            if (cached && (Date.now() - cached.timestamp < 24 * 60 * 60 * 1000)) {
                return cached.txResponses;
            }
            return undefined;
        },
        cacheTxResponses(height: string | number, responses: any[]) {
            const h = String(height);
            if (this.blockCache[h]) {
                this.blockCache[h].txResponses = responses;
            }
        },
        toggleTxFilter(type: 'msgTypes' | 'creators', value: string) {
            const list = this.txFilterState[type];
            if (list.includes(value)) {
                this.txFilterState[type] = list.filter(x => x !== value);
            } else {
                this.txFilterState[type].push(value);
            }
        },
        clearTxFilter() {
            this.txFilterState = { msgTypes: [], creators: [] };
        },
        async fetchAbciInfo() {
            return this.blockchain.rpc.getBaseNodeInfo();
        },
        // async fetchNodeInfo() {
        //     return this.blockchain.rpc.no()
        // }
    },
});
