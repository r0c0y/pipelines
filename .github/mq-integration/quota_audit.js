'use strict';
const fs = require('node:fs');
const path = require('node:path');
const BASELINE_SHA = '57147c5c22e58014f71e0181ced4cc07f82e1773';
const FIXED_SHA = '82693a708c36867e3ee3d3846112889153d2bed1';
const CONTROL = 'codex/mq-integration-controller-rerun-20261113';
const EVIDENCE = path.join(process.env.RUNNER_TEMP || '/tmp', 'mq-quota-audit-evidence');

function assertReadOnly(options) {
  const method = String(options.method || '').toUpperCase();
  const endpoint = String(options.url || '').split('?')[0].replace(/^https?:\/\/[^/]+/, '');
  if (endpoint === '/graphql') {
    const queries = [];
    if (options.query !== undefined) queries.push(options.query);
    for (const payload of [options.data, options.body]) {
      if (payload === undefined) continue;
      let value;
      try { value = typeof payload === 'string' ? JSON.parse(payload) : payload; }
      catch { throw new Error('Quota audit prohibits unrecognized GraphQL payloads'); }
      queries.push(value?.query);
    }
    // Check every possible transport representation, so a safe options.query
    // cannot disguise a different mutation in body/data. Reject conservatively.
    if (method !== 'POST' || !queries.length || queries.some(query =>
      typeof query !== 'string' || !/^\s*query\b/.test(query) || /\bmutation\b/i.test(query))) {
      throw new Error('Quota audit prohibits GraphQL mutations or unrecognized operations');
    }
    return;
  }
  if (!['GET', 'HEAD'].includes(method)) throw new Error('Quota audit prohibits REST mutations');
}

async function withReadOnlyRequests(github, operation) {
  if (typeof github.hook?.wrap !== 'function' || typeof github.hook?.remove !== 'function') {
    throw new Error('Quota audit requires a request mutation guard');
  }
  const guard = async (request, options) => { assertReadOnly(options); return request(options); };
  github.hook.wrap('request', guard);
  try { return await operation(); }
  finally { github.hook.remove('request', guard); }
}

async function run({github, context, core}) {
  if (context.repo.owner !== 'kubeflow' || context.repo.repo !== 'pipelines' ||
      context.eventName !== 'workflow_dispatch' || context.ref !== `refs/heads/${CONTROL}`) {
    throw new Error('Quota audit may run only on the isolated trusted controller branch');
  }
  fs.mkdirSync(EVIDENCE, {recursive:true});
  const results = [];
  core.setOutput('evidence', EVIDENCE);
  await withReadOnlyRequests(github, async () => {
    for (const [name, sha] of [['baseline',BASELINE_SHA],['fixed',FIXED_SHA]]) {
      // Distinct original runtime trees prevent the queue branch adapter's
      // module-cache changes from affecting either discovery implementation.
      const root = path.join(__dirname, `audit-${name}`);
      const scripts = path.join(root, '.github/resources/scripts');
      const {recoveryCandidates} = require(path.join(scripts, 'ci_passed'));
      const {withRequestAccounting} = require(path.join(scripts, 'github_request_accounting'));
      let accounting;
      const observedCore = {...core, info: message => {
        core.info(message);
        try { const value=JSON.parse(message); if(value.event==='github_request_accounting') accounting=value; }
        catch { /* No arbitrary log data is saved to the accounting record. */ }
      }};
      const start = new Date().toISOString();
      let candidates, error;
      try {
        candidates = await withRequestAccounting({github,core:observedCore,scope:'recovery'},
          () => recoveryCandidates({github,context:{...context,repo:context.repo,eventName:'schedule',payload:{}},root}));
      } catch (failure) { error = failure.message; }
      const record = {name,source:sha,start,end:new Date().toISOString(),
        measurement:'Read-only recovery discovery only; downstream publisher jobs are not executed.',
        selected_count:candidates?.length,candidates,accounting,error};
      fs.writeFileSync(path.join(EVIDENCE,`${name}.json`),JSON.stringify(record,null,2));
      results.push(record);
      if(error)throw new Error(`${name} quota audit failed: ${error}`);
    }
  });
  const summary={baseline_source:BASELINE_SHA,fixed_source:FIXED_SHA,
    baseline_selected:results[0].selected_count,fixed_selected:results[1].selected_count,
    baseline_discovery_requests:results[0].accounting?.requests,
    fixed_discovery_requests:results[1].accounting?.requests,
    removed_from_selection:results[0].candidates.filter(before=>!results[1].candidates.some(after=>after.number===before.number&&after.head===before.head)),
    added_to_selection:results[1].candidates.filter(after=>!results[0].candidates.some(before=>before.number===after.number&&before.head===after.head)),
    caveat:'Sequential live snapshots can differ as repository state changes. Discovery request counts exclude all downstream publisher work and other Actions clients; candidate-count reduction is not a measured total request saving.'};
  fs.writeFileSync(path.join(EVIDENCE,'summary.json'),JSON.stringify(summary,null,2));
  core.info(JSON.stringify(summary));
}
module.exports={assertReadOnly,withReadOnlyRequests,run};
