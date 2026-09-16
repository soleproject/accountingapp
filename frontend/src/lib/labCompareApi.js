import { api } from "./api";

export const labApi = {
  run:      (cid, phase = 1, opts = {}) =>
              api.post(`/companies/${cid}/lab/pipeline/run`,
                       null, { params: { phase, ...opts } }),
  runAsync: (cid, phase = 3, opts = {}) =>
              api.post(`/companies/${cid}/lab/pipeline/run-async`,
                       null, { params: { phase, ...opts } }),
  status:   (cid, jobId) =>
              api.get(`/companies/${cid}/lab/pipeline/status/${jobId}`),
  summary:  (cid) => api.get(`/companies/${cid}/lab/summary`),
  compare:  (cid, params) => api.get(`/companies/${cid}/lab/compare`, { params }),
  feedback: (cid, body) => api.post(`/companies/${cid}/lab/feedback`, body),
};
