
export interface CircleItem {
    id: string;
    value: number;
    r?: number; // Radius (calculated from value)
    x?: number;
    y?: number;
    option?: string;
    [key: string]: any;
}

/**
 * Calculates packed positions for bubbles using a true circle-packing algorithm.
 * Implements largest-first packing with tangent circles forming a dense, space-filling cluster.
 * 
 * Algorithm:
 * 1. Sorts items by size (descending) - largest first
 * 2. Places first item at center (0, 0)
 * 3. For each subsequent circle:
 *    a. Finds positions tangent to one existing circle (single-tangent)
 *    b. Finds positions tangent to two existing circles (double-tangent) for tighter packing
 *    c. Selects position that minimizes distance from center while avoiding collisions
 * 4. Uses minimal padding (near-zero) for tangent circles
 */
export function packCircles(items: CircleItem[]): CircleItem[] {
    if (items.length === 0) return [];

    // 1. Sort by value descending (largest first)
    const sorted = [...items].sort((a, b) => b.value - a.value);

    // 2. Map value to radius (sync with chart min/max config: 5px to 40px)
    const maxVal = sorted[0]?.value || 1;
    // ApexCharts scales bubble radius based on z value (value)
    // The formula approximates: radius scales with sqrt(area ratio)
    const scale = (val: number) => {
        const areaRatio = val / maxVal;
        return 5 + 35 * Math.sqrt(areaRatio);
    };

    const nodes = sorted.map(item => ({
        ...item,
        r: scale(item.value),
        x: 0,
        y: 0
    }));

    // 3. Circle packing with tangent placement
    const placed: typeof nodes = [];
    const padding = 0.1; // Minimal padding for tangent circles (essentially touching)

    /**
     * Check if a circle at (x, y) with radius r collides with any placed circle
     */
    const hasCollision = (x: number, y: number, r: number): boolean => {
        for (const other of placed) {
            const dx = x - other.x;
            const dy = y - other.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const minDist = r + other.r + padding;
            if (dist < minDist) {
                return true;
            }
        }
        return false;
    };

    /**
     * Find positions where a circle of radius r is tangent to circle c1
     * Returns array of candidate positions
     */
    const findSingleTangentPositions = (r: number, c1: typeof nodes[0], steps: number = 128): Array<{x: number, y: number}> => {
        const positions: Array<{x: number, y: number}> = [];
        const dist = c1.r + r + padding;
        
        for (let i = 0; i < steps; i++) {
            const angle = (i / steps) * 2 * Math.PI;
            const x = c1.x + Math.cos(angle) * dist;
            const y = c1.y + Math.sin(angle) * dist;
            positions.push({ x, y });
        }
        
        return positions;
    };

    /**
     * Find positions where a circle of radius r is tangent to both c1 and c2
     * Returns up to 2 positions (one on each side of the line connecting c1 and c2)
     */
    const findDoubleTangentPositions = (r: number, c1: typeof nodes[0], c2: typeof nodes[0]): Array<{x: number, y: number}> => {
        const positions: Array<{x: number, y: number}> = [];
        
        // Distance between centers of c1 and c2
        const dx = c2.x - c1.x;
        const dy = c2.y - c1.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        
        // If circles are too far apart or overlap, no double-tangent solution
        const minDist = c1.r + c2.r;
        const maxDist = c1.r + c2.r + 2 * r + 2 * padding;
        if (d < minDist || d > maxDist) {
            return positions;
        }
        
        // Calculate the position where the new circle touches both
        // Using law of cosines
        const r1 = c1.r + r + padding;
        const r2 = c2.r + r + padding;
        
        // Distance from c1 to the point where the new circle's center should be
        const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
        const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
        
        // Base point on the line between c1 and c2
        const baseX = c1.x + (a / d) * dx;
        const baseY = c1.y + (a / d) * dy;
        
        // Perpendicular vector (normalized)
        const perpX = (-dy / d) * h;
        const perpY = (dx / d) * h;
        
        // Two possible positions (one on each side)
        positions.push({ x: baseX + perpX, y: baseY + perpY });
        positions.push({ x: baseX - perpX, y: baseY - perpY });
        
        return positions;
    };

    // Place first circle at center
    if (nodes.length > 0) {
        nodes[0].x = 0;
        nodes[0].y = 0;
        placed.push(nodes[0]);
    }

    // Place remaining circles
    for (let i = 1; i < nodes.length; i++) {
        const current = nodes[i];
        let bestPos: { x: number, y: number } | null = null;
        let bestScore = Infinity;

        // Try double-tangent positions first (tighter packing)
        for (let j = 0; j < placed.length; j++) {
            for (let k = j + 1; k < placed.length; k++) {
                const positions = findDoubleTangentPositions(current.r, placed[j], placed[k]);
                for (const pos of positions) {
                    if (!hasCollision(pos.x, pos.y, current.r)) {
                        const distToCenter = Math.sqrt(pos.x * pos.x + pos.y * pos.y);
                        // Prefer positions closer to center
                        if (distToCenter < bestScore) {
                            bestScore = distToCenter;
                            bestPos = pos;
                        }
                    }
                }
            }
        }

        // If no double-tangent position found, try single-tangent positions
        if (!bestPos) {
            // Use higher resolution for single-tangent search
            const steps = 256;
            for (const anchor of placed) {
                const positions = findSingleTangentPositions(current.r, anchor, steps);
                for (const pos of positions) {
                    if (!hasCollision(pos.x, pos.y, current.r)) {
                        const distToCenter = Math.sqrt(pos.x * pos.x + pos.y * pos.y);
                        if (distToCenter < bestScore) {
                            bestScore = distToCenter;
                            bestPos = pos;
                        }
                    }
                }
            }
        }

        // Place the circle at the best position found
        if (bestPos) {
            current.x = bestPos.x;
            current.y = bestPos.y;
            placed.push(current);
        } else {
            // Fallback: spiral placement (should rarely happen)
            // Find the furthest placed circle and place tangent to it
            let maxDist = 0;
            let furthestCircle = placed[0];
            for (const p of placed) {
                const dist = Math.sqrt(p.x * p.x + p.y * p.y);
                if (dist > maxDist) {
                    maxDist = dist;
                    furthestCircle = p;
                }
            }
            const angle = Math.atan2(furthestCircle.y, furthestCircle.x);
            const dist = furthestCircle.r + current.r + padding;
            current.x = furthestCircle.x + Math.cos(angle) * dist;
            current.y = furthestCircle.y + Math.sin(angle) * dist;
            placed.push(current);
        }
    }

    return nodes;
}
