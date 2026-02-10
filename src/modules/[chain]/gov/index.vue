<script lang="ts" setup>
import { useGovStore, useValidatorStore } from '@/stores';
import ProposalListItem from '@/components/ProposalListItem.vue';
import ProposalListSkeleton from '@/components/ProposalListSkeleton.vue';
import { ref, onMounted } from 'vue';
import PaginationBar from '@/components/PaginationBar.vue';
import { PageRequest } from '@/types';

const tab = ref('2');
const store = useGovStore();
const validatorStore = useValidatorStore();
const pageRequest = ref(new PageRequest())

onMounted(() => {
  console.log('gov index onMounted');  
  validatorStore.init(); // Initialize validator data for the list (ProposalProcess)
  store.fetchProposals('2').then((x) => {
    if (x?.proposals?.length === 0) {
      tab.value = '3';
    }
  });
  store.fetchProposals('3');
  store.fetchProposals('4');
});

const changeTab = (val: '2' | '3' | '4') => {
    tab.value = val;
};

function page(p: number) {
    pageRequest.value.setPage(p)
    store.fetchProposals(tab.value, pageRequest.value)
}

</script>

<template>
    <div>
        <div class="tabs tabs-boxed bg-transparent mb-4 text-center">
            <a class="tab text-gray-400 uppercase" :class="{ 'tab-active': tab === '2' }" @click="changeTab('2')">{{ $t('gov.voting') }}</a>
            <a class="tab text-gray-400 uppercase" :class="{ 'tab-active': tab === '3' }" @click="changeTab('3')">{{ $t('gov.passed') }}</a>
            <a class="tab text-gray-400 uppercase" :class="{ 'tab-active': tab === '4' }"
                @click="changeTab('4')">{{ $t('gov.rejected') }}</a>
        </div>
        <!-- Loading skeleton -->
        <ProposalListSkeleton v-if="store?.loading?.[tab] === 1" :rows="5" />

        <!-- Empty states -->
        <div v-else-if="(store?.proposals?.[tab]?.proposals?.length || 0) === 0" class="bg-white dark:bg-[#28334e] rounded text-sm p-6 text-center text-gray-500 dark:text-gray-400">
            <template v-if="tab === '2'">
                There are no active proposals right now. Check back later to see what’s up for voting.
            </template>
            <template v-else-if="tab === '3'">
                No passed proposals to show. Stay tuned for future decisions.
            </template>
            <template v-else>
                Nothing has been rejected yet.
            </template>
        </div>

        <!-- List -->
        <ProposalListItem v-else :proposals="store?.proposals[tab]" />

        <!-- Pagination (hide when loading or empty) -->
        <PaginationBar
            v-if="store?.loading?.[tab] !== 1 && (store?.proposals?.[tab]?.proposals?.length || 0) > 0"
            :total="store?.proposals[tab]?.pagination?.total"
            :limit="pageRequest.limit"
            :callback="page"
        />
    </div>
</template>
<route>
  {
    meta: {
      i18n: 'governance',
      order: 6,
      descriptionKey: 'gov.meta_description'
    }
  }
</route>
