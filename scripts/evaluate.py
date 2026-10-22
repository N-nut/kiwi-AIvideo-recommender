"""Reproducible reference checks; AI annotations must not be reported as human ratings."""
import argparse
import asyncio
import hashlib
import json
import statistics
import time
from datetime import datetime, timezone

from kiwi.config import ROOT, Settings
from kiwi.database import Work, initialize, make_database
from kiwi.importer import import_works
from kiwi.providers import BaselineAI, LiveAI, PROMPT_VERSION
from kiwi.rules import satisfies
from kiwi.schemas import Preferences, RecommendationRequest
from kiwi.service import recommend


async def run_case(case, sessions, settings, provider, use_parse):
    start=time.perf_counter()
    try:
        prefs=await asyncio.wait_for(provider.parse(case['text']),settings.request_timeout) if use_parse else Preferences.model_validate(case['preferences'])
        result=await asyncio.wait_for(recommend(RecommendationRequest(preferences=prefs),sessions,provider,settings,case['id']),settings.request_timeout)
        returned=[i['id'] for i in result['items']]
        relevant=set(case['relevant_ids'])
        violations=[];invalid_evidence=[]
        with sessions() as session:
            for item in result['items']:
                work=session.get(Work,item['id'])
                if not work or not satisfies(work,prefs):violations.append(item['id'])
                evidence={e['id']:e['quote'] for e in item['evidence']}
                if any(i not in evidence for i in item['evidence_ids']) or any(not any(q in evidence.get(i,'') for i in item['evidence_ids']) for q in item['quotes']):invalid_evidence.append(item['id'])
        return {"id":case['id'],"text":case['text'],"status":result['status'],"returned_ids":returned,
                "candidate_ids":result['candidate_ids'][:10],"reference_recall_at_10":len(relevant & set(result['candidate_ids'][:10]))/len(relevant) if relevant else None,
                "reference_precision":len(relevant & set(returned))/len(returned) if returned else None,
                "hard_violations":violations,"invalid_evidence":invalid_evidence,
                "reason_modes":[w['reason_mode'] for w in result['items']],"warnings":result['warnings'],
                "timings_ms":result['timings_ms'],"end_to_end_ms":round((time.perf_counter()-start)*1000,2),"usage":result['usage'],
                "preferences":prefs.model_dump()}
    except Exception as exc:
        return {"id":case['id'],"text":case['text'],"status":"error","error_type":type(exc).__name__,"error":str(exc),"end_to_end_ms":round((time.perf_counter()-start)*1000,2)}


async def main(args):
    source=(ROOT/'data/works.json').read_bytes()
    dataset=(ROOT/'data/evaluation.json').read_bytes()
    cases=json.loads(dataset)['cases']
    if not cases:
        raise SystemExit('旧 36 部参考集已停用，请先针对当前红果作品库重新标注 data/evaluation.json。')
    settings=Settings(ai_mode='live' if args.live else 'baseline')
    if args.live:
        engine,sessions=make_database(settings.database_url)
    else:
        engine,sessions=make_database('sqlite:///:memory:');initialize(engine)
        await import_works(json.loads(source),sessions,BaselineAI(),settings)
    semaphore=asyncio.Semaphore(args.concurrency)
    async def evaluate(case):
        async with semaphore:
            result=await run_case(case,sessions,settings,LiveAI(settings) if args.live else BaselineAI(),args.parse)
            print(f"{case['id']} {result['status']} {result.get('returned_ids',[])}",flush=True)
            return result
    results=await asyncio.gather(*(evaluate(case) for case in cases))
    successful=[r for r in results if r['status']!='error']
    recalls=[r['reference_recall_at_10'] for r in successful if r['reference_recall_at_10'] is not None]
    precision=[r['reference_precision'] for r in successful if r['reference_precision'] is not None]
    latencies=sorted(r['end_to_end_ms'] for r in results)
    report={"generated_at":datetime.now(timezone.utc).isoformat(),"mode":settings.ai_mode,
            "preference_input":"live-model" if args.parse else "fixed-confirmed-structure",
            "dataset_version":json.loads(dataset)['version'],"data_sha256":hashlib.sha256(source).hexdigest(),"evaluation_sha256":hashlib.sha256(dataset).hexdigest(),
            "prompt_version":PROMPT_VERSION,"model":settings.deepseek_model if args.live else None,
            "embedding_model":settings.embedding_model if args.live else None,"embedding_dimension":settings.embedding_dimension if args.live else None,
            "min_similarity":settings.min_similarity,"semantic_only_threshold":settings.semantic_only_threshold,"storage":engine.dialect.name,
            "annotation_notice":"AI reference labels only. Independent human relevance and claim-support evaluation pending.",
            "summary":{"queries":len(results),"errors":len(results)-len(successful),
                       "hard_violations":sum(len(r['hard_violations']) for r in successful),"invalid_evidence":sum(len(r['invalid_evidence']) for r in successful),
                       "mean_reference_recall_at_10":statistics.mean(recalls) if recalls else None,"mean_reference_precision":statistics.mean(precision) if precision else None,
                       "latency_p50_ms":statistics.median(latencies),"latency_p95_ms":latencies[max(0,int(len(latencies)*.95)-1)],
                       "calls":sum(r.get('usage',{}).get('calls',0) for r in results),"tokens":sum(r.get('usage',{}).get('tokens',0) for r in results)},
            "results":results}
    output=ROOT/'docs'/f"evaluation-{'live' if args.live else 'baseline'}{'-parse' if args.parse else ''}.json"
    output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(report['summary'],ensure_ascii=False))
    engine.dispose()
    if report['summary']['errors'] or report['summary']['hard_violations'] or report['summary']['invalid_evidence']:raise SystemExit(1)


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--live',action='store_true',help='Paid provider calls; import real embeddings first')
    parser.add_argument('--parse',action='store_true',help='Also evaluate natural language parsing; otherwise use confirmed reference structures')
    parser.add_argument('--concurrency',type=int,choices=[1,2],default=1)
    asyncio.run(main(parser.parse_args()))
