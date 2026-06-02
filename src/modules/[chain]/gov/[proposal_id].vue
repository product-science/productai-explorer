<script lang="ts" setup>
import { computed, ref, reactive } from 'vue';
import MdEditor from 'md-editor-v3';
import ObjectElement from '@/components/dynamic/ObjectElement.vue';
import {
  useBaseStore,
  useBlockchain,
  useFormatter,
  useGovStore,
  useStakingStore,
  useTxDialog,
  useValidatorStore,
} from '@/stores';
import { Icon } from '@iconify/vue';
import { PageRequest, type Pagination } from '@/types/common';
import type { GovProposal, GovVote, PaginatedProposalDeposit, Tally } from '@/types/gov';
import Countdown from '@/components/Countdown.vue';
import PaginationBar from '@/components/PaginationBar.vue';
import { fromBech32, toHex } from '@cosmjs/encoding';
import { accountToOperatorAddress } from '@/libs/address';
import { calculateEpochStagesForBlock } from '@/libs/epochCalculator';
import { packCircles } from '@/libs/chartLayouts';
import {
  formatProposalType,
  proposalHasMultipleMessages,
  proposalPrimaryMsgType,
} from '@/libs/utils';
import { useI18n } from 'vue-i18n';
import VueApexCharts from 'vue3-apexcharts';
import { JsonViewer } from 'vue3-json-viewer';
import { colorVariables } from '@/components/charts/apexChartConfig';
import 'md-editor-v3/lib/style.css';
import 'vue3-json-viewer/dist/index.css';

interface ExtendedGovVote extends GovVote {
  power?: number;
  timestamp?: string;
  height?: number;
}



const props = defineProps(['proposal_id', 'chain']);
const proposal = ref({} as GovProposal);
const format = useFormatter();
const store = useGovStore();
const baseStore = useBaseStore();
const dialog = useTxDialog();
const stakingStore = useStakingStore();
const chainStore = useBlockchain();
const validatorStore = useValidatorStore();
const { t } = useI18n();

const tab = ref('details'); // Default to details to show context first, or 'votes' if user prefers

const targetEpochIndex = ref(0);
const votingStartBlock = ref(0);

// Initialize
loadProposalData(props.proposal_id);

async function loadProposalData(id: string) {
    // 1. Fetch Proposal Details
    const res = await store.fetchProposal(id);
    let proposalDetail = reactive(res.proposal);
    proposal.value = proposalDetail;

    // 2. Parallel Fetches
    // Fetch Quorum for display
    chainStore.rpc.getGovParamsTally().then((res) => {
      if(res.tally_params) {
          quorum.value = Number(res.tally_params.quorum);
      }
    });

    // We rely on baseStore for current block height (updated periodically)
    // No need for separate RPC call for base block latest

    // 3. Status Specific Logic
    if (res.proposal?.status === 'PROPOSAL_STATUS_VOTING_PERIOD') {
        // Fetch Tally
        store.fetchTally(id).then((tallRes) => {
            proposalDetail.final_tally_result = tallRes?.tally;
        });
        validatorStore.init();
    }

    // 4. Calculate Epoch and Load Weights (Critical for Vote Power)
    const startBlock = await fetchVotingStartBlock(id);
    votingStartBlock.value = startBlock;
    
    if (startBlock > 0) {
        let idx = 0;
        // Try fetching exact epoch info at height from chain first
        const epochInfo = await validatorStore.fetchEpochInfoAtHeight(startBlock);
        if (epochInfo?.latest_epoch?.index) {
             idx = Number(epochInfo.latest_epoch.index);
        } else {
             // Fallback to local calculation
             const stages = calculateEpochStagesForBlock(startBlock);
             idx = stages?.epoch_index || 0;
        }

        targetEpochIndex.value = idx;

        if (idx > 0) {
            // AWAIT this to ensure weights are loaded before processing votes
            await validatorStore.fetchEpochParticipants(idx);
            
            // 5. Load Votes (only after weights are ready)
            fetchVotesFromTxs(id, pageRequest.value).then((x) => {
                 votes.value = x.votes;
                 pageResponse.value = x.pagination;
                 fetchAllVotes(); 
            });
        }
    } else {
        fetchVotesFromTxs(id, pageRequest.value).then((x) => {
             votes.value = x.votes;
             pageResponse.value = x.pagination;
        });
    }

    // 6. Load Param Changes (if applicable)
    if(proposalDetail.content?.changes) {
        proposalDetail.content?.changes.forEach((item) => {  
            chainStore.rpc.getParams(item.subspace, item.key).then((res) => {
              if(proposal.value.content && res.param) {
                if(proposal.value.content.current){
                  proposal.value.content.current.push(res.param);
                } else {
                  proposal.value.content.current = [res.param];
                };
              }
            })
        })
    }

    // 7. Load Current Params for UpdateParams proposals
    const msgType = proposalDetail.content?.['@type'] || '';
    if(msgType.endsWith('MsgUpdateParams')) {
        if(msgType.indexOf('staking') > -1) {
            chainStore.rpc.getStakingParams().then((res) => addCurrentParams(res));
        } else if(msgType.indexOf('gov') > -1) {
            chainStore.rpc.getGovParamsVoting().then((res) => addCurrentParams(res));
        } else if(msgType.indexOf('distribution') > -1) {
            chainStore.rpc.getDistributionParams().then((res) => addCurrentParams(res));
        } else if(msgType.indexOf('slashing') > -1) {
            chainStore.rpc.getSlashingParams().then((res) => addCurrentParams(res));
        }
    }
}

function addCurrentParams(res: any) {
  if(proposal.value.content && res.params) {
    proposal.value.content.params = [proposal.value.content?.params];
    proposal.value.content.current = [res.params];
  }
}
const color = computed(() => {
  if (proposal.value.status === 'PROPOSAL_STATUS_PASSED') {
    return 'text-success';
  } else if (proposal.value.status === 'PROPOSAL_STATUS_REJECTED') {
    return 'text-error';
  }
  return 'text-info';
});
const status = computed(() => {
  if (proposal.value.status) {
    return proposal.value.status.replace('PROPOSAL_STATUS_', '');
  }
  return '';
});

const isFinalized = computed(() => {
  const s = proposal.value.status || '';
  return s === 'PROPOSAL_STATUS_PASSED' || s === 'PROPOSAL_STATUS_REJECTED';
});




const votes = ref([] as ExtendedGovVote[]);

const voterTab = ref('all'); // 'all', 'yes', 'no', 'veto', 'abstain'

// Sorting
type SortKey = 'power' | 'height';
const sortBy = ref<SortKey>('power');
const sortDesc = ref(true);

function toggleSort(key: SortKey) {
    if (sortBy.value === key) {
        sortDesc.value = !sortDesc.value;
    } else {
        sortBy.value = key;
        sortDesc.value = true; // Default to descending
    }
}

function sortIcon(key: SortKey) {
    if (sortBy.value !== key) return 'mdi:chevron-up';
    return sortDesc.value ? 'mdi:chevron-down' : 'mdi:chevron-up';
}

const uniqueVotes = computed(() => {
    const list = allVotes.value || votes.value || [];
    if (!Array.isArray(list) || list.length === 0) return [];

    const latest = new Map<string, ExtendedGovVote>();
    for (const v of list) {
        const existing = latest.get(v.voter);
        if (!existing) {
            latest.set(v.voter, v);
        } else {
            // Compare height (or duplicate logic if needed)
            const h1 = Number(v.height || 0);
            const h2 = Number(existing.height || 0);
            if (h1 > h2) {
                latest.set(v.voter, v);
            } else if (h1 === h2) {
                latest.set(v.voter, v); 
            }
        }
    }
    return Array.from(latest.values());
});

const filteredVotes = computed(() => {
    const list = uniqueVotes.value;
    let result = list;

    // Filter
    if(voterTab.value !== 'all') {
        result = list.filter(v => {
            if(voterTab.value === 'yes') return v.option === 'VOTE_OPTION_YES';
            if(voterTab.value === 'no') return v.option === 'VOTE_OPTION_NO';
            if(voterTab.value === 'veto') return v.option === 'VOTE_OPTION_NO_WITH_VETO';
            if(voterTab.value === 'abstain') return v.option === 'VOTE_OPTION_ABSTAIN';
            return true;
        })
    }

    // Sort
    return [...result].sort((a, b) => {
        let valA = 0;
        let valB = 0;

        if (sortBy.value === 'power') {
            valA = a.power || 0;
            valB = b.power || 0;
        } else if (sortBy.value === 'height') {
            valA = Number(a.height || 0);
            valB = Number(b.height || 0);
        }

        return sortDesc.value ? valB - valA : valA - valB;
    });
});

// Calculate local tally from all votes
const localTally = computed(() => {
    const list = uniqueVotes.value;
    // If no local votes loaded, fallback to return null/zeros so we use chain tally
    if (!list || list.length === 0) return null;

    let yes = 0;
    let no = 0;
    let veto = 0;
    let abstain = 0;

    for (const v of list) {
        const p = v.power || 0;
        if (v.option === 'VOTE_OPTION_YES') yes += p;
        else if (v.option === 'VOTE_OPTION_NO') no += p;
        else if (v.option === 'VOTE_OPTION_NO_WITH_VETO') veto += p;
        else if (v.option === 'VOTE_OPTION_ABSTAIN') abstain += p;
        else if (v.options) {
             // Weighted vote
             for (const opt of v.options) {
                 // Weight in MsgVoteWeighted is decimal string 0..1
                 const w = Number(opt.weight);
                 const portion = p * w;
                 if (opt.option === 'VOTE_OPTION_YES') yes += portion;
                 else if (opt.option === 'VOTE_OPTION_NO') no += portion;
                 else if (opt.option === 'VOTE_OPTION_NO_WITH_VETO') veto += portion;
                 else if (opt.option === 'VOTE_OPTION_ABSTAIN') abstain += portion;
             }
        }
    }
    return { yes, no, no_with_veto: veto, abstain, total: yes + no + veto + abstain };
});

const themeParams = computed(() => {
  const theme = baseStore.theme || 'light';
  return colorVariables(theme); 
});

const voteColors = {
  yes: '#36d399',
  no: '#f87272',
  veto: '#fbbd23',
  abstain: '#3abff8'
};

// Bubble Chart Logic (SVG circle packing)
type PackedBubble = {
  id: string;
  x: number;
  y: number;
  r: number;
  value: number;
  option: 'yes' | 'no' | 'veto' | 'abstain';
  color: string;
};

function effectiveVoteOption(v: ExtendedGovVote): PackedBubble['option'] | null {
  // Normal vote
  if (v.option && v.option !== 'VOTE_OPTION_UNSPECIFIED') {
    if (v.option === 'VOTE_OPTION_YES') return 'yes';
    if (v.option === 'VOTE_OPTION_NO') return 'no';
    if (v.option === 'VOTE_OPTION_NO_WITH_VETO') return 'veto';
    if (v.option === 'VOTE_OPTION_ABSTAIN') return 'abstain';
  }

  // Weighted vote: pick the highest-weight option as the bubble category
  if (v.options && v.options.length) {
    const top = [...v.options].sort((a, b) => Number(b.weight) - Number(a.weight))[0];
    if (!top) return null;
    if (top.option === 'VOTE_OPTION_YES') return 'yes';
    if (top.option === 'VOTE_OPTION_NO') return 'no';
    if (top.option === 'VOTE_OPTION_NO_WITH_VETO') return 'veto';
    if (top.option === 'VOTE_OPTION_ABSTAIN') return 'abstain';
  }

  return null;
}

const packedBubbles = computed<PackedBubble[]>(() => {
  const list = uniqueVotes.value;

  // Take top 60 by power
  const topVoters = [...list]
    .filter((v) => (v.power || 0) > 0)
    .sort((a, b) => (b.power || 0) - (a.power || 0))
    .slice(0, 60);

  const items = topVoters
    .map((v) => {
      const opt = effectiveVoteOption(v);
      if (!opt) return null;
      return {
        id: v.voter,
        value: v.power || 0,
        option: opt,
      };
    })
    .filter(Boolean) as Array<{ id: string; value: number; option: PackedBubble['option'] }>;

  const packed = packCircles(items);

  return packed
    .map((p) => {
      const opt = p.option as PackedBubble['option'];
      const color =
        opt === 'yes'
          ? voteColors.yes
          : opt === 'no'
            ? voteColors.no
            : opt === 'veto'
              ? voteColors.veto
              : voteColors.abstain;

      return {
        id: p.id,
        x: p.x || 0,
        y: p.y || 0,
        r: p.r || 0,
        value: p.value,
        option: opt,
        color,
      };
    })
    // Safety: drop any malformed nodes
    .filter((c) => c.r > 0);
});

const packedBubblesViewBox = computed(() => {
  const circles = packedBubbles.value;
  if (!circles.length) return '0 0 100 100';

  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;

  for (const c of circles) {
    minX = Math.min(minX, c.x - c.r);
    minY = Math.min(minY, c.y - c.r);
    maxX = Math.max(maxX, c.x + c.r);
    maxY = Math.max(maxY, c.y + c.r);
  }

  const pad = 6;
  minX -= pad;
  minY -= pad;
  maxX += pad;
  maxY += pad;

  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  return `${minX} ${minY} ${w} ${h}`;
});

// Timeline Logic
const timelineSeries = computed(() => {
    const list = uniqueVotes.value;
    // Sort by time
    const sorted = [...list].sort((a, b) => new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime());
    
    // Accumulate
    let accYes = 0, accNo = 0, accVeto = 0, accAbstain = 0;
    const dataYes: any[] = [];
    const dataNo: any[] = [];
    const dataVeto: any[] = [];
    const dataAbstain: any[] = [];

    sorted.forEach(v => {
        const time = new Date(v.timestamp || 0).getTime();
        if(!time) return;
        const p = v.power || 0;
        if(v.option === 'VOTE_OPTION_YES') accYes += p;
        if(v.option === 'VOTE_OPTION_NO') accNo += p;
        if(v.option === 'VOTE_OPTION_NO_WITH_VETO') accVeto += p;
        if(v.option === 'VOTE_OPTION_ABSTAIN') accAbstain += p;
        
        dataYes.push([time, accYes]);
        dataNo.push([time, accNo]);
        dataVeto.push([time, accVeto]);
        dataAbstain.push([time, accAbstain]);
    });

    return [
        { name: 'Yes', data: dataYes, color: voteColors.yes },
        { name: 'No', data: dataNo, color: voteColors.no },
        { name: 'Veto', data: dataVeto, color: voteColors.veto },
        { name: 'Abstain', data: dataAbstain, color: voteColors.abstain }
    ];
});

const timelineOptions = computed(() => {
    const theme = baseStore.theme || 'light';
    const params = colorVariables(theme);

    return {
        chart: { type: 'line', toolbar: { show: false }, zoom: { enabled: true }, background: 'transparent' },
        dataLabels: { enabled: false },
        colors: [voteColors.yes, voteColors.no, voteColors.veto, voteColors.abstain],
        stroke: { curve: 'stepline', width: 2, colors: [voteColors.yes, voteColors.no, voteColors.veto, voteColors.abstain] },
        xaxis: { 
            type: 'datetime',
            tooltip: { enabled: false },
            axisBorder: { show: false },
            axisTicks: { show: false },
            labels: {
                style: { colors: params.themeSecondaryTextColor, fontSize: '12px' }
            }
        },
        yaxis: { 
             labels: {
                 style: { colors: params.themeSecondaryTextColor, fontSize: '12px' },
                 formatter: (val: number) => Math.floor(val).toLocaleString()
             }
        },
        grid: {
            show: true,
            borderColor: params.themeBorderColor,
            strokeDashArray: 3,
            xaxis: { lines: { show: false } },
            yaxis: { lines: { show: true } },
        },
        tooltip: { theme: theme === 'dark' ? 'dark' : 'light' },
        legend: {
            markers: { fillColors: [voteColors.yes, voteColors.no, voteColors.veto, voteColors.abstain] },
            labels: { colors: params.themePrimaryTextColor }
        }
    }
});


function setActiveTab(t: string) {
    if(t === 'votes') {
        fetchAllVotes(); // Trigger full fetch
    }
    tab.value = t;
}
// Status formatting and countdown logic
const statusFormatted = computed(() => {
  if (!proposal.value.status) return '';
  const text = proposal.value.status.replace('PROPOSAL_STATUS_', '').replace(/_/g, ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
});

const currentHeight = computed(() => {
    return Number(baseStore.latest?.block?.header?.height || 0);
});



const countdownTarget = computed(() => {
    const status = proposal.value.status;
    if (status === 'PROPOSAL_STATUS_VOTING_PERIOD') {
        const end = new Date(proposal.value.voting_end_time).getTime();
        return end - Date.now();
    }
    
    // Check for plan/height based countdown (e.g. software upgrade)
    const content: any = proposal.value.content;
    if (status === 'PROPOSAL_STATUS_PASSED' && content?.plan?.height) {
        const targetHeight = Number(content.plan.height);
        if (targetHeight > currentHeight.value && currentHeight.value > 0) {
            const diff = targetHeight - currentHeight.value;
            return diff * 5000; // 5 seconds per block approximation (fallback)
        }
    }
    return 0;
});

const allVotes = ref<ExtendedGovVote[] | null>(null);
const matchedVoters = ref<Set<string> | null>(null);
const matchedIndices = ref<number[] | null>(null);
const currentMatchIndex = ref<number | null>(null);
const allVotesLoading = ref(false);
const searchQuery = ref('');
const searchError = ref('');
const highlightedVoter = ref<string | null>(null);

const quorum = ref(0);

const pageRequest = ref(new PageRequest());
const pageResponse = ref({} as Pagination);
const currentPage = ref(1);

// Ensure default page size is 20
pageRequest.value.setPageSize(20);
pageRequest.value.setPage(1);

// Initial vote fetch is now handled by fetchVotesFromTxs further down
// store.fetchProposalVotes removed

function shortTime(v: string) {
  if (v) {
    return format.toDay(v, 'from');
  }
  return '';
}

const votingCountdown = computed((): number => {
  const now = new Date();
  const end = new Date(proposal.value.voting_end_time);
  return end.getTime() - now.getTime();
});

const upgradeCountdown = computed((): number => {
  const height = Number(proposal.value.content?.plan?.height || 0);
  if (height > 0) {
    const base = useBaseStore();
    const current = Number(base.latest?.block?.header?.height || 0);
    return (height - current) * Number((base.blocktime / 1000).toFixed()) * 1000;
  }

  const now = new Date();
  const end = new Date(proposal.value.content?.plan?.time || '');
  return end.getTime() - now.getTime();
});

const total = computed(() => {
  const tally = (proposal.value.final_tally_result as Tally) || localTally.value;
  if (!tally) return 0;
  return Number(tally.yes || 0) + Number(tally.no || 0) + Number(tally.no_with_veto || 0) + Number(tally.abstain || 0);
});

const proposalType = computed(() => {
    if (proposalHasMultipleMessages(proposal.value)) {
      return t('gov.multiple_messages');
    }
    return formatProposalType(proposalPrimaryMsgType(proposal.value));
});

const proposalSummaryExcerpt = computed(() => {
  const p = proposal.value;
  return p?.summary || p?.content?.description || metaItem(p?.metadata)?.summary || '';
});

const voteDetails = computed(() => {
  const tally = (proposal.value.final_tally_result as Tally) || localTally.value || {
    yes: 0,
    no: 0,
    no_with_veto: 0,
    abstain: 0,
  };
  
  const yes = Number(tally.yes);
  const no = Number(tally.no);
  const veto = Number(tally.no_with_veto);
  const abstain = Number(tally.abstain);
  const sum = yes + no + veto + abstain;

  if (sum === 0) return [
      { label: 'YES', percent: 0, amount: 0, color: 'success', barColor: 'bg-success' },
      { label: 'NO', percent: 0, amount: 0, color: 'base-content', barColor: 'bg-base-content/50' },
      { label: 'VETO', percent: 0, amount: 0, color: 'warning', barColor: 'bg-warning' },
      { label: 'ABSTAIN', percent: 0, amount: 0, color: 'info', barColor: 'bg-info' }
  ];

  return [
    { label: 'YES', percent: (yes / sum) * 100, amount: yes, color: 'success', barColor: 'bg-success' },
    { label: 'NO', percent: (no / sum) * 100, amount: no, color: 'base-content', barColor: 'bg-base-content/50' },
    { label: 'VETO', percent: (veto / sum) * 100, amount: veto, color: 'warning', barColor: 'bg-warning' },
    { label: 'ABSTAIN', percent: (abstain / sum) * 100, amount: abstain, color: 'info', barColor: 'bg-info' }
  ];
});

const turnout = computed(() => {
    // 0. If Voting Period, use activeStakingTotal (matching List View / ProposalProcess logic)
    if (proposal.value.status === 'PROPOSAL_STATUS_VOTING_PERIOD') {
        const activeTotal = validatorStore.activeStakingTotal;
        // If activeTotal is ready, use it. If not, return 0 to avoid using fallback (bonded_tokens) which causes flickering.
        if (activeTotal && activeTotal > 0 && total.value) {
            return (Number(total.value) / activeTotal) * 100;
        }
        return 0; 
    }

    // 1. Try to get Total Power from the specific Epoch's group data
    const epochIndex = targetEpochIndex.value;
    let totalPower = 0;
    
    if (epochIndex > 0 && validatorStore.epochDataCache[epochIndex]) {
        totalPower = validatorStore.epochDataCache[epochIndex].totalPower;
    }

    // 2. (Removed) Fallback to current staking pool is disabled as API returns 0s.
    
    if (!localTally.value && !proposal.value.final_tally_result) return 0;
    if (totalPower === 0) return 0;
    
    // total.value is sum of votes cast based on their power
    return (total.value / totalPower) * 100;
});

const turnoutLoading = computed(() => {
    // If we haven't loaded the proposal status yet, we are loading
    if (!proposal.value || !proposal.value.status) return true;

    if (proposal.value.status === 'PROPOSAL_STATUS_VOTING_PERIOD') {
        // Loading if active staking total is not ready
        return !validatorStore.activeStakingTotal || validatorStore.activeStakingTotal === 0;
    }

    // For closed proposals, we need epoch data
    const epochIndex = targetEpochIndex.value;
    // If we haven't determined epoch index yet (and it's not 0 fallback), we are loading
    if (epochIndex === 0) return false; 
    
    // Check if we have the cache
    return !validatorStore.epochDataCache[epochIndex];
});

const quorumLoading = computed(() => !quorum.value || quorum.value === 0);

// Deprecated individual computed props if not used, or aliased to voteDetails
const yes = computed(() => voteDetails.value.find(x => x.label === 'YES')?.percent || 0);
const no = computed(() => voteDetails.value.find(x => x.label === 'NO')?.percent || 0);
const veto = computed(() => voteDetails.value.find(x => x.label === 'VETO')?.percent || 0);
const abstain = computed(() => voteDetails.value.find(x => x.label === 'ABSTAIN')?.percent || 0);


function getVoterDisplay(voter: string) {
  let name = voter;
  try {
      const { data } = fromBech32(voter);
      const hex = toHex(data);
      const v = stakingStore.validators.find(
        (x) => toHex(fromBech32(x.operator_address).data) === hex
      );
      if(v) {
          // If moniker is identical to operator address, use the account address (voter) instead
          // to avoid displaying the long operator address twice.
          if (v.description.moniker === v.operator_address) {
              name = voter;
          } else {
              name = v.description.moniker;
          }
      }
  } catch(e){
  }
  return {
    name,
    operator: accountToOperatorAddress(voter)
  }
}

async function fetchVotingStartBlock(proposalId: string): Promise<number> {
  // Query to find transactions related to the proposal that could have started the voting period
  // We look for 'submit_proposal' and 'proposal_deposit' events
  // The logic is to find the latest transaction among these that happened BEFORE or AT the voting_start_time
  // However, since we might not have exact time mapping for every block easily without fetching them,
  // we can rely on the fact that the transition to VOTING_PERIOD happens at a specific block height.
  // We can just fetch the txs and pick the one that is most likely the trigger.
  // Actually, usually the last deposit or the submit proposal (if immediate voting) trigger it.
  // Let's fetch both types of events
  const qSubmit = `query=submit_proposal.proposal_id='${proposalId}'`;
  const qDeposit = `query=proposal_deposit.proposal_id='${proposalId}'`;
  
  // We can't easily OR in this specific rpc search syntax usually without complex composite keys or multiple requests
  // So we make two requests
  const [resSubmit, resDeposit] = await Promise.all([
     chainStore.rpc.getTxs(qSubmit, {}, new PageRequest()),
     chainStore.rpc.getTxs(qDeposit, {}, new PageRequest())
  ]);

  const txs = [
      ...(resSubmit.tx_responses || []),
      ...(resDeposit.tx_responses || [])
  ];

  if (txs.length === 0) return 0;

  // Sort by height descending
  txs.sort((a, b) => Number(b.height) - Number(a.height));

  // The latest interaction (highest height) is *likely* the one that pushed it to voting period 
  // (unless it's already in voting period and people are depositing more? usually not allowed/needed)
  // But strictly, we should check the voting_start_time vs tx time.
  // Let's assume the highest height related tx is close enough to the start block.
  // For safety, if we have the proposal voting_start_time, we could compare.
  // But simplified approach: return the highest height.
  return Number(txs[0].height);
}

async function fetchVotesFromTxs(proposalId: string, page: PageRequest) {
  // Use the pre-calculated epoch index if available, else try to fetch if not already done
  let epochIndex = targetEpochIndex.value;
  if(epochIndex === 0) {
      const startBlock = await fetchVotingStartBlock(proposalId);
      if(startBlock > 0) {
          const stages = calculateEpochStagesForBlock(startBlock);
          epochIndex = stages?.epoch_index || 0;
           // If we calculated it here late, might want to set the ref (though improved logic sets it on mount)
           if(!targetEpochIndex.value) targetEpochIndex.value = epochIndex;
      }
  }
  
  if(epochIndex > 0) {
      // Ensure we have the weights for this epoch
      // If we already fetched it in mount, this is quick/cached
      // But if we missed it or logic race, fetch here
      if (!validatorStore.epochDataCache[epochIndex]) {
           await validatorStore.fetchEpochParticipants(epochIndex);
      }
  }

  const query = `query=proposal_vote.proposal_id='${proposalId}'`;
  const res = await chainStore.rpc.getTxs(query, {}, page);
  
  const votes: ExtendedGovVote[] = [];
  
  // Get the weights map
  const epochData = validatorStore.epochDataCache[epochIndex];
  const weightsByAccount = epochData?.weightsByAccount || {};

  if (res && res.tx_responses) {
    res.tx_responses.forEach((txResp) => {
      // Access messages from the transaction
      const msgs = txResp.tx?.body?.messages || [];
      const timestamp = txResp.timestamp;
      const height = Number(txResp.height);

      msgs.forEach((msg: any) => {
        // Handle MsgVote and MsgVoteWeighted
        const type = msg['@type'] || '';
        if (
          (type.includes('MsgVote') || type.includes('MsgVoteWeighted')) && 
          String(msg.proposal_id) === String(proposalId)
        ) {
          const voter = msg.voter;
          // Calculate power directly from account mapping in epoch data
          const power = weightsByAccount[voter] || 0;

          votes.push({
            proposal_id: msg.proposal_id,
            voter: voter,
            option: msg.option,  // For MsgVote
            options: msg.options, // For MsgVoteWeighted
            power: power,
            timestamp,
            height
          });
        }
      });
    });
  }

  return {
    votes,
    pagination: res.pagination
  };
}

function pageload(p: number) {
  currentPage.value = p;
  pageRequest.value.setPage(p);
  fetchVotesFromTxs(props.proposal_id, pageRequest.value).then((x) => {
    votes.value = x.votes;
    pageResponse.value = x.pagination;
  });
}

// Initial load


async function fetchAllVotes() {
  if (allVotesLoading.value || allVotes.value) return;
  allVotesLoading.value = true;
  try {
    const fullPage = new PageRequest();
    fullPage.setPageSize(100);
    fullPage.setPage(1);
    fullPage.count_total = true;

    let aggregated: GovVote[] = [];
    const first = await fetchVotesFromTxs(props.proposal_id, fullPage);
    const batchVotes = first.votes || [];
    aggregated = aggregated.concat(batchVotes);
    
    // If we got less than page size, we are done
    let fetchedCount = batchVotes.length;
    let pageNum = 1;
    
    // Safety break: 100 pages * 100 items = 10000 votes max
    while (fetchedCount === 100 && pageNum < 100) {
      pageNum++;
      fullPage.setPage(pageNum);

      const res = await fetchVotesFromTxs(props.proposal_id, fullPage);
      const batch = res.votes || [];
      if (!batch.length) break;
      aggregated = aggregated.concat(batch);
      fetchedCount = batch.length;
    }

    allVotes.value = aggregated;
  } finally {
    allVotesLoading.value = false;
  }
}

async function performSearch() {
  searchError.value = '';
  highlightedVoter.value = null;
  matchedVoters.value = null;
  matchedIndices.value = null;
  currentMatchIndex.value = null;

  const q = searchQuery.value.trim();
  if (!q) return;

  // Make sure validator store is initialized so mappings are available
  if (!validatorStore.initialized) {
    await validatorStore.init();
  }

  await fetchAllVotes();
  const list = uniqueVotes.value || [];
  if (!list.length) {
    searchError.value = 'No votes loaded yet.';
    return;
  }

  const lower = q.toLowerCase();
  const accountToOperator = validatorStore.accountToOperatorMap;
  const participantsTotals = validatorStore.participantsTotalsByOperator;
  const validators = stakingStore.validators || [];

  const indices: number[] = [];

  list.forEach((vote, idx) => {
    const voter = vote.voter || '';
    const items: string[] = [voter.toLowerCase()];

    const op = accountToOperator[voter];
    if (op) {
      items.push(op.toLowerCase());
      const totals = participantsTotals[op];
      if (totals?.account_address) {
        items.push(totals.account_address.toLowerCase());
      }

      const validator = validators.find((v) => v.operator_address === op);
      const moniker = validator?.description?.moniker;
      if (moniker) {
        items.push(moniker.toLowerCase());
      }
    }

    if (items.some((s) => s.includes(lower))) {
      indices.push(idx);
    }
  });

  if (!indices.length) {
    searchError.value = 'No matching voter found.';
    return;
  }

  matchedIndices.value = indices;
  matchedVoters.value = new Set(indices.map((i) => list[i].voter));

  const perPage = pageRequest.value.limit || 20;

  // Helper to go to a specific match by its index in matchedIndices
  const goToMatchAt = (matchPos: number) => {
    if (!matchedIndices.value || !matchedIndices.value.length) return;
    const clampedPos = Math.min(Math.max(0, matchPos), matchedIndices.value.length - 1);
    const globalIndex = matchedIndices.value[clampedPos];
    const vote = list[globalIndex];
    const page = Math.floor(globalIndex / perPage) + 1;
    currentMatchIndex.value = clampedPos;
    highlightedVoter.value = vote.voter;
    pageload(page);
  };

  // Always go to the first match initially
  goToMatchAt(0);
}

function gotoNextMatch() {
  if (!matchedIndices.value || !matchedIndices.value.length) return;
  const list = uniqueVotes.value || [];
  const perPage = pageRequest.value.limit || 20;
  const current = currentMatchIndex.value ?? 0;
  const next = (current + 1) % matchedIndices.value.length;
  const globalIndex = matchedIndices.value[next];
  const vote = list[globalIndex];
  const page = Math.floor(globalIndex / perPage) + 1;
  currentMatchIndex.value = next;
  highlightedVoter.value = vote.voter;
  pageload(page);
}

function gotoPrevMatch() {
  if (!matchedIndices.value || !matchedIndices.value.length) return;
  const list = uniqueVotes.value || [];
  const perPage = pageRequest.value.limit || 20;
  const len = matchedIndices.value.length;
  const current = currentMatchIndex.value ?? 0;
  const prev = (current - 1 + len) % len;
  const globalIndex = matchedIndices.value[prev];
  const vote = list[globalIndex];
  const page = Math.floor(globalIndex / perPage) + 1;
  currentMatchIndex.value = prev;
  highlightedVoter.value = vote.voter;
  pageload(page);
}

function resetSearch() {
  searchQuery.value = '';
  searchError.value = '';
  highlightedVoter.value = null;
  matchedVoters.value = null;
  matchedIndices.value = null;
  currentMatchIndex.value = null;
}

function rowClass(item: GovVote, _localIndex: number) {
  const isMatched =
    matchedVoters.value !== null && matchedVoters.value.has(item.voter);

  return {
    '!bg-primary !text-white': isMatched,
  };
}

function metaItem(metadata: string|undefined): { title: string; summary: string } {
  if (!metadata) {
    return { title: '', summary: '' }
  } else if (metadata.startsWith('{') && metadata.endsWith('}')) {
    return JSON.parse(metadata)
  }
  return { title: metadata, summary: '' }
}

// Pagination logic for messages
const messagePage = ref(1);

const proposalMessages = computed(() => {
    // If we have messages array (v1), use it
    if(proposal.value.messages && proposal.value.messages.length > 0) {
        return proposal.value.messages;
    }
    // Fallback to legacy content (beta1)
    return [proposal.value.content];
});

const currentMessage = computed(() => {
    const list = proposalMessages.value;
    const page = messagePage.value;
    if(!list || list.length === 0) return {};
    
    // Safety check
    const index = Math.max(0, Math.min(page - 1, list.length - 1));
    return list[index];
});
</script>

<template>
  <div>
    <!-- Title Card -->
    <div class="bg-base-100 rounded-lg shadow p-3 mb-4 relative">
       <!-- Top Row: Badge -->
       <div class="mb-4">
           <span class="badge badge-primary bg-opacity-20 text-primary border-none px-3 py-2 rounded-full text-xs font-semibold uppercase tracking-wide">
               {{ proposalType }}
           </span>
       </div>

       <!-- Title -->
       <h1 class="text-2xl font-bold mb-2 pr-32">
           #{{ proposal_id }}. {{ proposal.title || proposal.content?.title || metaItem(proposal?.metadata)?.title  }}
       </h1>

       <p v-if="proposalSummaryExcerpt" class="text-sm text-base-content/60 line-clamp-2 mb-4 max-w-4xl">
         {{ proposalSummaryExcerpt }}
       </p>

       <!-- Voting Time -->
       <div class="text-sm text-base-content/60 mb-6">
           Voting Time: {{ format.toDay(proposal.voting_start_time, 'long') }} ~ {{ format.toDay(proposal.voting_end_time, 'long') }}
       </div>

       <!-- Description (Moved here) -->
       <div v-if="proposal.summary || proposal.content?.description || metaItem(proposal?.metadata)?.summary" class="mb-8">
         <div class="divider text-xs font-bold text-base-content/40 uppercase tracking-widest text-left justify-start">DESCRIPTION</div>
        {{ format.multiLine(proposal.summary || proposal.content?.description || metaItem(proposal?.metadata)?.summary) }}
       </div>

       <!-- Status Row -->
       <div class="flex flex-wrap items-start gap-8 md:gap-16 mb-8">
           <div>
               <div class="text-xs text-base-content/60 mb-1 uppercase tracking-wider">Proposal Status</div>
               <div class="text-2xl font-bold uppercase" :class="color">
                   {{ statusFormatted }}
               </div>
           </div>
           <div v-if="countdownTarget > 0">
                <div class="text-xs text-base-content/60 mb-1 uppercase tracking-wider">Countdown</div>
                <Countdown :time="countdownTarget" :short="true" css="text-2xl" />
           </div>
           <div>
               <div class="text-xs text-base-content/60 mb-1 uppercase tracking-wider">Turnout / Quorum</div>
                <div class="text-2xl font-bold text-base-content uppercase flex items-center gap-2">
                    <span v-if="!turnoutLoading">{{ turnout.toFixed(2) }}%</span>
                    <span v-else class="inline-block w-24 h-8 bg-base-content/20 animate-pulse rounded"></span>

                    <span>/</span>

                    <span v-if="!quorumLoading">{{ (quorum * 100).toFixed(2) }}%</span>
                    <span v-else class="inline-block w-24 h-8 bg-base-content/20 animate-pulse rounded"></span>
                </div>
           </div>
           
           <!-- Vote Button -->
           <div v-if="proposal.status === 'PROPOSAL_STATUS_VOTING_PERIOD'" class="ml-auto">
                <div class="text-xs text-transparent mb-1 uppercase tracking-wider select-none">Action</div>
                 <label
                      for="vote"
                      class="btn btn-primary px-8 h-10 min-h-0 text-lg uppercase font-bold inline-flex items-center justify-center cursor-pointer"
                      @click="dialog.open('vote', { proposal_id })"
                 >
                      {{ $t('gov.btn_vote') }}
                 </label>
           </div>
       </div>

       <!-- Vote Cards Grid -->
       <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
           <div v-for="item in voteDetails" :key="item.label" class="bg-base-200/50 rounded-lg p-4 border border-base-300">
               <div class="flex justify-between items-baseline mb-1">
                   <div class="font-bold text-base-content">{{ item.label }}</div>
                   <div class="font-bold" :class="`text-${item.color}`">{{ item.percent.toFixed(2) }}%</div>
               </div>
                <div class="text-right text-xs text-base-content/60 mb-3">
                    {{ Number(item.amount).toLocaleString() }}
                </div>
               <div class="w-full h-1 bg-base-300 rounded-full overflow-hidden">
                   <div class="h-full rounded-full" :class="item.barColor" :style="{ width: `${item.percent}%` }"></div>
               </div>
           </div>
       </div>
    </div>

    <!-- Tabs -->
    <div class="mb-4">
        <div class="btn-group">
            <button 
                class="btn btn-sm md:btn-md bg-gray-100 text-gray-500 hover:text-white border-none dark:bg-gray-800 dark:text-white uppercase font-bold"
                :class="{ '!btn-primary': tab === 'votes' }"
                @click="setActiveTab('votes')"
            >
                Votes
            </button>
            <button 
                class="btn btn-sm md:btn-md bg-gray-100 text-gray-500 hover:text-white border-none dark:bg-gray-800 dark:text-white uppercase font-bold"
                :class="{ '!btn-primary': tab === 'details' }"
                @click="setActiveTab('details')"
            >
                Details
            </button>
            <button 
                class="btn btn-sm md:btn-md bg-gray-100 text-gray-500 hover:text-white border-none dark:bg-gray-800 dark:text-white uppercase font-bold"
                :class="{ '!btn-primary': tab === 'json' }"
                @click="setActiveTab('json')"
            >
                JSON
            </button>
        </div>
    </div>

    <!-- Tab Content: Votes -->
    <div v-if="tab === 'votes'">
        <!-- Charts Card -->
        <div class="bg-base-100 rounded-lg shadow p-6 mb-4">
             <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div class="bg-base-200/30 rounded-lg p-4 relative min-h-[350px]">
                    <h3 class="font-bold mb-4 text-center">Vote Distribution</h3>
                    <div v-if="allVotesLoading" class="absolute inset-0 flex items-center justify-center z-10">
                        <span class="loading loading-spinner loading-lg text-primary"></span>
                    </div>
                    <div v-else class="w-full h-[300px]">
                      <svg
                        class="w-full h-full"
                        :viewBox="packedBubblesViewBox"
                        preserveAspectRatio="xMidYMid meet"
                      >
                        <g>
                          <circle
                            v-for="c in packedBubbles"
                            :key="c.id"
                            :cx="c.x"
                            :cy="c.y"
                            :r="c.r"
                            :fill="c.color"
                            fill-opacity="0.85"
                            stroke="rgba(255,255,255,0.9)"
                            stroke-width="2"
                          />
                        </g>
                      </svg>
                    </div>
                </div>
                <div class="bg-base-200/30 rounded-lg p-4 relative min-h-[350px]">
                    <h3 class="font-bold mb-4 text-center">Voting Power Timeline</h3>
                    <div v-if="allVotesLoading" class="absolute inset-0 flex items-center justify-center z-10">
                         <span class="loading loading-spinner loading-lg text-primary"></span>
                    </div>
                    <VueApexCharts v-else width="100%" height="300" :options="timelineOptions" :series="timelineSeries"></VueApexCharts>
                </div>
            </div>
        </div>

        <!-- Voter List Controls -->
        <div class="mb-4">
            <div class="flex flex-col md:flex-row justify-between items-center gap-4">
                <!-- Detached, Bigger Switcher -->
                <!-- Detached, Bigger Switcher as Button Group -->
                <div class="btn-group">
                    <button
                        class="btn btn-sm md:btn-md bg-gray-100 text-gray-500 hover:text-white border-none dark:bg-gray-800 dark:text-white uppercase font-bold"
                        :class="{
                            '!btn-primary': voterTab === 'all',
                            'opacity-50': (allVotes || []).length === 0 && voterTab !== 'all'
                        }"
                        @click="voterTab = 'all'"
                    >
                        ALL
                    </button>
                    <button
                        class="btn btn-sm md:btn-md bg-gray-100 text-gray-500 hover:text-white border-none dark:bg-gray-800 dark:text-white uppercase font-bold"
                        :class="{
                             '!btn-primary': voterTab === 'yes',
                             'opacity-50': (localTally?.yes || 0) === 0 && voterTab !== 'yes'
                        }"
                        @click="voterTab = 'yes'"
                    >
                        YES
                    </button>
                    <button
                        class="btn btn-sm md:btn-md bg-gray-100 text-gray-500 hover:text-white border-none dark:bg-gray-800 dark:text-white uppercase font-bold"
                        :class="{
                             '!btn-primary': voterTab === 'no',
                             'opacity-50': (localTally?.no || 0) === 0 && voterTab !== 'no'
                        }"
                        @click="voterTab = 'no'"
                    >
                        NO
                    </button>
                    <button
                        class="btn btn-sm md:btn-md bg-gray-100 text-gray-500 hover:text-white border-none dark:bg-gray-800 dark:text-white uppercase font-bold"
                        :class="{
                             '!btn-primary': voterTab === 'veto',
                             'opacity-50': (localTally?.no_with_veto || 0) === 0 && voterTab !== 'veto'
                        }"
                        @click="voterTab = 'veto'"
                    >
                        VETO
                    </button>
                    <button
                        class="btn btn-sm md:btn-md bg-gray-100 text-gray-500 hover:text-white border-none dark:bg-gray-800 dark:text-white uppercase font-bold"
                        :class="{
                             '!btn-primary': voterTab === 'abstain',
                             'opacity-50': (localTally?.abstain || 0) === 0 && voterTab !== 'abstain'
                        }"
                        @click="voterTab = 'abstain'"
                    >
                        ABSTAIN
                    </button>
                </div>

                <!-- Search Field -->
                 <div class="form-control w-full md:w-auto">
                    <div class="input-group">
                        <input 
                            type="text" 
                            placeholder="SEARCH VOTER..." 
                            class="input input-bordered w-full md:w-64" 
                            v-model="searchQuery"
                            @keyup.enter="performSearch"
                        />
                        <button class="btn btn-square" @click="performSearch">
                            <span class="loading loading-spinner loading-xs" v-if="allVotesLoading"></span>
                            <svg v-else xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                        </button>
                    </div>
                     <!-- Search navigation if multiple matches -->
                     <div class="flex justify-end mt-1 gap-1" v-if="matchedIndices && matchedIndices.length > 0">
                        <button class="btn btn-xs" @click="gotoPrevMatch">Prev</button>
                        <span class="text-xs self-center">{{ (currentMatchIndex || 0) + 1 }} / {{ matchedIndices.length }}</span>
                        <button class="btn btn-xs" @click="gotoNextMatch">Next</button>
                        <button class="btn btn-xs btn-ghost text-error" @click="resetSearch">Clear</button>
                     </div>
                     <div v-if="searchError" class="text-error text-xs mt-1 text-right">{{ searchError }}</div>
                </div>
            </div>
        </div>

        <!-- Voter List Table -->
        <div class="bg-base-100 rounded-lg shadow border border-base-200 overflow-x-auto relative">
          <table class="table w-full relative border-separate border-spacing-0 vote-table">
            <thead>
                <tr>
                    <th scope="col" class="uppercase sticky top-0 z-10 bg-base-200">
                        <span class="inline-flex items-center">Voter</span>
                    </th>
                    <th scope="col" class="uppercase sticky top-0 z-10 bg-base-200">
                        <span class="inline-flex items-center">Option</span>
                    </th>
                    <th scope="col" class="uppercase cursor-pointer select-none sticky top-0 z-10 bg-base-200 th-hover" @click="toggleSort('height')">
                        <span class="inline-flex items-center">Block<Icon :icon="sortIcon('height')" class="ml-1" /></span>
                    </th>
                    <th scope="col" class="text-right uppercase cursor-pointer select-none sticky top-0 z-10 bg-base-200 th-hover" @click="toggleSort('power')">
                         <span class="inline-flex items-center justify-end w-full">Power<Icon :icon="sortIcon('power')" class="ml-1" /></span>
                    </th>
                </tr>
            </thead>
            <tbody>
              <tr v-for="(item, index) of filteredVotes" :key="index" :class="rowClass(item, index)" class="hover:bg-gray-100 dark:hover:bg-[#384059]">
                <td class="pt-2 pb-2 text-sm font-mono border-b border-base-200">
                    <div class="flex items-center gap-2">
                        <div class="avatar placeholder">
                            <div class="bg-neutral-focus text-neutral-content rounded-full w-6">
                                <span class="text-xs">{{ getVoterDisplay(item.voter).name.substring(0,1) }}</span>
                            </div>
                        </div>
                        <div class="flex flex-col">
                            <span class="font-semibold">{{ getVoterDisplay(item.voter).name }}</span>
                            <span class="text-xs text-base-content/40">{{ getVoterDisplay(item.voter).operator }}</span>
                        </div>
                    </div>
                </td>
                <td
                  class="py-2 text-sm font-bold border-b border-base-200"
                  :class="{
                    'text-success': item.option === 'VOTE_OPTION_YES',
                    'text-error': item.option === 'VOTE_OPTION_NO' || item.option === 'VOTE_OPTION_NO_WITH_VETO',
                    'text-info': item.option === 'VOTE_OPTION_ABSTAIN',
                  }"
                >
                    <template v-if="item.option && item.option !== 'VOTE_OPTION_UNSPECIFIED'">
                         {{ String(item.option).replace('VOTE_OPTION_', '') }}
                    </template>
                    <template v-else-if="item.options">
                        {{ item.options.map(x => `${x.option.replace('VOTE_OPTION_', '')}: ${format.percent(x.weight)}`).join(', ') }}
                    </template>
                </td>
                <td class="py-2 text-sm font-mono border-b border-base-200">
                    {{ item.height ? Number(item.height).toLocaleString() : '-' }}
                </td>
                <td class="py-2 text-sm font-mono text-right border-b border-base-200">
                    {{ ((item).power || 0).toLocaleString() }}
                </td>
              </tr>
              <tr v-if="filteredVotes.length === 0">
                  <td colspan="4" class="text-center py-8 text-base-content/50">No votes found in this category</td>
              </tr>
            </tbody>
          </table>
          <div v-if="filteredVotes.length > 20" class="text-center text-xs text-base-content/50 mt-4 pb-4">
              Showing all {{ filteredVotes.length }} loaded votes.
          </div>
        </div>
    </div>

    <!-- Tab Content: Details -->
    <template v-if="tab === 'details'">
        <!-- Pagination for multiple messages — sits above the card -->
        <div v-if="proposalMessages.length > 1" class="mb-4">
            <div class="text-center text-xs text-base-content/60 uppercase tracking-widest mb-2">
                Message {{ messagePage }} of {{ proposalMessages.length }}
            </div>
            <PaginationBar
                :total="String(proposalMessages.length)"
                :limit="1"
                :callback="(p: number) => messagePage = p"
                :page="messagePage"
                :maxVisible="5"
            />
        </div>

        <div class="bg-base-100 rounded-lg shadow p-6">
            <ObjectElement :value="currentMessage" />
        </div>
    </template>

    <!-- Tab Content: JSON -->
    <div v-if="tab === 'json'" class="bg-base-100 rounded-lg shadow p-6">
        <JsonViewer :value="proposal" copyable boxed sort theme="light" />
    </div>

  </div>
</template>

<style>
/* Scoped-like styles for the vote table to match validator table feel */
.vote-table thead th {
    position: sticky;
    top: 0;
    z-index: 10;
}
.vote-table thead th:first-child {
    position: sticky;
    left: 0;
    z-index: 11; /* Higher than other headers */
    background: hsl(var(--b2));
}
.vote-table tbody td:first-child {
    position: sticky;
    left: 0;
    z-index: 1;
    background: hsl(var(--b1));
}
.vote-table tbody tr:hover td:first-child {
    background-color: #f3f4f6;
}
.dark .vote-table tbody tr:hover td:first-child {
    background-color: #384059;
}
.vote-table thead th.th-hover {
    transition: background-color 0.15s ease-in-out, color 0.15s ease-in-out;
}
.vote-table thead th.th-hover:hover {
    background-color: hsl(var(--b3));
    color: #ffffff;
}

@media (max-width: 768px) {
    .vote-table thead th:first-child,
    .vote-table tbody td:first-child {
        width: 35vw;
        min-width: 35vw;
        max-width: 35vw;
        white-space: normal; /* Allow wrapping if needed? User didn't ask but good for small width */
        overflow: hidden; 
        text-overflow: ellipsis;
    }
}
</style>
