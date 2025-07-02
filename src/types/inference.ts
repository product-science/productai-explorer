export interface InferenceResponse {
  stats: {
    epoch_id: string;
    timestamp: string;
    inference: {
      inference_id: string;
      epoch_poc_block_height: string;
      status: string;
      total_token_count: string;
      model: string;
      actual_cost_in_coins: string;
    };
  }[];
}

export interface Inference {
  inference_id: string;
  epoch_poc_block_height: string;
  status: string;
  total_token_count: string;
  model: string;
  actual_cost_in_coins: string;
}

export interface InferenceStat {
  epoch_id: string;
  timestamp: string;
  inference: Inference;
} 