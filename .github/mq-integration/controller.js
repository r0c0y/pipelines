'use strict';
const fs = require('node:fs');
const path = require('node:path');
const BASE = 'codex-mq-integration-rerun-20261113';
const CONTROL = 'codex/mq-integration-controller-rerun-20261113';
const root = path.join(__dirname, 'runtime');
const scripts = path.join(root, '.github/resources/scripts');
const expected = require(path.join(scripts, 'ci_expected_workflows'));
const originalInventory = expected.loadBaseInventory;
// Test branch routing only; exact upstream blobs and inventory completeness still validate.
expected.loadBaseInventory = async options => {
  const value = await originalInventory(options);
  if (options.pullRequest.base.ref !== BASE) throw Error('Harness inventory outside test base');
  const copy = structuredClone(value);
  for (const workflow of copy.inventory.workflows) {
    if (workflow.merge_group?.branches?.includes('master')) workflow.merge_group.branches.push(BASE);
  }
  return copy;
};
const gate = require(path.join(scripts, 'ci_passed'));
const admission = require(path.join(scripts, 'merge_queue_admission'));
const dispatch = require(path.join(scripts, 'merge_queue_dispatch'));
const {withRequestAccounting} = require(path.join(scripts, 'github_request_accounting'));
const EVIDENCE = path.join(process.env.RUNNER_TEMP || '/tmp', 'mq-integration-evidence');
fs.mkdirSync(EVIDENCE, {recursive:true});
function ensure(context) {
  if (context.repo.owner !== 'kubeflow' || context.repo.repo !== 'pipelines' ||
      context.eventName !== 'workflow_dispatch' || context.ref !== `refs/heads/${CONTROL}`) {
    throw Error('Controller may run only on the isolated trusted controller branch');
  }
}
function save(name, value) { fs.writeFileSync(path.join(EVIDENCE, name), JSON.stringify(value,null,2)); }
async function selected(github, context, number) {
  if (!Number.isSafeInteger(number) || number <= 0) throw Error('Expected PR number');
  const {data:pr}=await github.rest.pulls.get({...context.repo,pull_number:number});
  if (pr.base.ref !== BASE || pr.base.repo.full_name !== 'kubeflow/pipelines') throw Error('PR outside isolated base');
  return pr;
}
function prContext(context, pr) {
  return {...context,repo:context.repo,eventName:'pull_request_target',payload:{action:'synchronize',pull_request:pr}};
}
function recordMutations(github) {
  github.hook.after('request', (response, options) => {
    if (options.method === 'GET') return;
    const url = String(options.url || '').split('?')[0];
    const kind = url.endsWith('/graphql') ?
      (/enqueuePullRequest/.test(options.query || '') ? 'enqueue' :
       /dequeuePullRequest/.test(options.query || '') ? 'dequeue' : 'graphql') :
      /\/dispatches$/.test(url) ? 'workflow_dispatch' :
      /\/statuses\//.test(url) ? 'commit_status' : 'other';
    fs.appendFileSync(path.join(EVIDENCE,'api-operations.jsonl'), JSON.stringify({
      time:new Date().toISOString(),method:options.method,kind,status:response.status})+'\n');
  });
}
async function prepare({github,context,core,number}) {
  ensure(context); recordMutations(github);
  const pr=await selected(github,context,number);
  save('selected-pr-before.json',pr);
  const outputs={};
  const observedCore={...core,setOutput:(name,value)=>{outputs[name]=value;core.setOutput(name,value);}};
  await gate.prepare({github,context:prContext(context,pr),core:observedCore,root});
  save('prepare.json',outputs);
}
async function finalize({github,context,core,number,head,before,pollPassed,pollSkipped,preparedResult}) {
  ensure(context);recordMutations(github);
  const pr=await selected(github,context,Number(number));
  await gate.finalize({github,context:prContext(context,pr),core,root,number,head,before,pollPassed,pollSkipped,preparedResult});
}
async function recover({github,context,core,number,admit=false}) {
  ensure(context);recordMutations(github);
  let trustedContext={...context,repo:context.repo,eventName:'schedule',payload:{}};
  if (admit) trustedContext=prContext(context,await selected(github,context,number));
  await dispatch.reconcileQueue({github,context:trustedContext,core,root,queueOnly:!admit});
}
async function snapshot({github,context,core,number}) {
  ensure(context);
  const errors=[];
  try {
    const queue=await admission.readQueue(github,context,BASE);save('queue.json',queue);
    for (const sha of new Set(queue.map(entry=>entry.headCommit?.oid).filter(Boolean))) {
      const runs=await github.paginate(github.rest.actions.listWorkflowRunsForRepo,{...context.repo,head_sha:sha,per_page:100});
      save(`runs-${sha}.json`,runs);
      const statuses=await github.paginate(github.rest.repos.listCommitStatusesForRef,{...context.repo,ref:sha,per_page:100});
      save(`statuses-${sha}.json`,statuses);
    }
  } catch(error) {errors.push(error.message);}
  if (number) {
    try {const pr=await selected(github,context,number);save('selected-pr-after.json',pr);
      save('pr-statuses.json',await github.paginate(github.rest.repos.listCommitStatusesForRef,{...context.repo,ref:pr.head.sha,per_page:100}));
    } catch(error) {errors.push(error.message);}
  }
  save('summary.json',{base:BASE,controller:CONTROL,controllerSha:context.sha,runId:context.runId,at:new Date().toISOString(),errors});
  core.setOutput('evidence',EVIDENCE);
}
function measured(name, operation) {
  return async options => {
    ensure(options.context);
    const measuredCore = {...options.core, info: message => {
      options.core.info(message);
      try {
        const record = JSON.parse(message);
        if (record.event === 'github_request_accounting') save(`${name}-requests.json`, record);
      } catch { /* Ordinary controller messages are not accounting records. */ }
    }};
    return withRequestAccounting({github: options.github, core: measuredCore,
      scope: ['prepare', 'finalize'].includes(name) ? name : 'recovery'},
      () => operation({...options, core: measuredCore}));
  };
}
module.exports={prepare:measured('prepare',prepare),finalize:measured('finalize',finalize),
  recover:measured('recover',recover),snapshot:measured('snapshot',snapshot)};
