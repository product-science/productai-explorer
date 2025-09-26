import { useBlockchain } from "@/stores";
import { createRouter, createWebHistory } from "vue-router";
// @ts-ignore
import { setupLayouts } from "virtual:generated-layouts";
// @ts-ignore
import routes from "~pages";

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [...setupLayouts(routes)],
});

// Add this global beforeEach guard
router.beforeEach(async (to, from, next) => {
  const { chain } = to.params;
  if (chain) {
    const blockchain = useBlockchain();
    
    // Set current chain (this may trigger async loading)
    if (chain !== blockchain.chainName) {
      await blockchain.setCurrent(chain.toString());
    }

    // Check if we're on the chain root (dashboard) and should redirect to first feature
    const isChainRoot = to.path === `/${chain}` || (to.matched.length > 0 && to.matched[0].meta?.i18n === 'dashboard');
    
    if (isChainRoot) {
      console.log(`Detected chain root visit for ${chain}, checking for redirect...`);
      
      // Wait a bit for the chain to be loaded if needed
      let retries = 0;
      while (!blockchain.current && retries < 20) {
        await new Promise(resolve => setTimeout(resolve, 50));
        retries++;
      }
      
      // Find the first enabled feature that has a route
      const features = blockchain.current?.features || [];
      console.log(`Available features for ${chain}:`, features);
      
      if (features.length > 0) {
        const allRoutes = router.getRoutes();
        const firstFeature = features.find(feature =>
          allRoutes.some(route => route.meta?.i18n === feature)
        );
        
        console.log(`First available feature: ${firstFeature}`);
        
        if (firstFeature) {
          // Find the route path for this feature
          const featureRoute = allRoutes.find(route => route.meta?.i18n === firstFeature);
          if (featureRoute) {
            // Ensure we only use a string path
            let routePath: string | undefined;
            const p = featureRoute.path;
            if (typeof p === 'string') {
              routePath = p;
            } else if (Array.isArray(p) && typeof p[0] === 'string') {
              routePath = p[0];
            }
            if (typeof routePath === 'string') {
              const path = routePath.replace(':chain', String(chain));
              console.log(`Redirecting from /${chain} to ${path} (first feature: ${firstFeature})`);
              return next({ path, replace: true });
            }
          }
        }
      }
      
      console.log(`No redirect needed or available for ${chain}`);
    }
  }
  // Handle root path: redirect to default chain, then its first feature via guard above
  if (to.path === '/' || to.matched.length === 0) {
    const blockchain = useBlockchain();
    // Ensure chains are initialized
    if (!blockchain.chainName) {
      // Calling dashboard.initial() will set default chain via setupDefault
      try {
        await blockchain.dashboard.initial();
      } catch {}
    }
    if (blockchain.chainName) {
      return next({ path: `/${blockchain.chainName}`, replace: true });
    }
  }
  next();
});

// Docs: https://router.vuejs.org/guide/advanced/navigation-guards.html#global-before-guards

export default router;