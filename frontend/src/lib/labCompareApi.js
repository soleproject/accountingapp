import { api } from "./api";

export const labApi = {
  run:      (cid) => api.post(`/companies/${cid}/lab/pipeline/run`),
  summary:  (cid) => api.get(`/companies/${cid}/lab/summary`),
  compare:  (cid, params) => api.get(`/companies/${cid}/lab/compare`, { params }),
  feedback: (cid, body) => api.post(`/companies/${cid}/lab/feedback`, body),
};
