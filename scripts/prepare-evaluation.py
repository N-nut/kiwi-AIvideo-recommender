import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CASES = [
    ("想看修仙穿越", {"soft_preferences":{"genres":["修仙"],"themes":["穿越"]}}, [102998,149529]),
    ("想看都市修仙", {"soft_preferences":{"genres":["都市","修仙"]}}, [102867,102892,102829,102893]),
    ("只看末世，想要系统", {"required":[{"field":"genres","value":"末世"}],"soft_preferences":{"themes":["系统"]}}, [149520]),
    ("想看武侠穿越", {"soft_preferences":{"genres":["武侠"],"themes":["穿越"]}}, [28092,103000]),
    ("想看经营做生意的故事", {"soft_preferences":{"themes":["经营"]}}, [45128,45991,102999]),
    ("想看重生复仇", {"soft_preferences":{"themes":["重生","复仇"]}}, [102894,111618,102829]),
    ("想看系统升级", {"soft_preferences":{"themes":["系统","成长"]}}, [149531,121468,148585,113970]),
    ("想看成长冒险", {"soft_preferences":{"themes":["成长","冒险"]}}, [32556,33874,43048,121468]),
    ("只看恋爱，想有修仙", {"required":[{"field":"genres","value":"恋爱"}],"soft_preferences":{"genres":["修仙"]}}, [102864]),
    ("只看末世", {"required":[{"field":"genres","value":"末世"}]}, [102872,149520]),
    ("只看都市", {"required":[{"field":"genres","value":"都市"}]}, [102867,102892,102829,102893]),
    ("只看玄幻，必须有系统", {"required":[{"field":"genres","value":"玄幻"},{"field":"themes","value":"系统"}]}, [149531,121468,149530,148585,149529,113970]),
    ("想看修仙，不要后宫", {"soft_preferences":{"genres":["修仙"]},"excluded_features":["harem"]}, []),
    ("想看都市，不要感情线", {"soft_preferences":{"genres":["都市"]},"excluded_features":["romance"]}, []),
    ("想看玄幻，不要虐心", {"soft_preferences":{"genres":["玄幻"]},"excluded_features":["tragic"]}, []),
    ("只看末世，不要修仙", {"required":[{"field":"genres","value":"末世"}],"excluded_genres":["修仙"]}, [102872,149520]),
    ("想看逆袭，必须快节奏", {"soft_preferences":{"themes":["逆袭"]},"required":[{"field":"pace","value":"快"}]}, []),
    ("只看已经完结的修仙剧", {"soft_preferences":{"genres":["修仙"]},"unresolved_constraints":["只看完结"]}, []),
    ("只看修仙，不要修仙", {"required":[{"field":"genres","value":"修仙"}],"excluded_genres":["修仙"]}, []),
    ("只看科幻", {"required":[{"field":"genres","value":"科幻"}]}, []),
    ("只看悬疑", {"required":[{"field":"genres","value":"悬疑"}]}, []),
    ("想看温暖治愈的奶爸故事", {"soft_preferences":{"themes":["治愈"]}}, [149526]),
    ("想看弱者逆袭", {"soft_preferences":{"themes":["逆袭"]}}, [102887,103017,45128,103000,103003]),
    ("想看修仙，但不要都市", {"soft_preferences":{"genres":["修仙"]},"excluded_genres":["都市"]}, [102998,102894,149529,103007,102864,102999]),
]


if __name__ == '__main__':
    rows = [{"id":f"q{i+1:02}","text":text,"preferences":prefs,"relevant_ids":[f"bili-{sid}" for sid in ids],
             "annotation_method":"AI source-based reference; independent human relevance grading pending"} for i,(text,prefs,ids) in enumerate(CASES)]
    (ROOT/'data/evaluation.json').write_text(json.dumps({"version":"2026-10-21-v1","cases":rows},ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(f'{len(rows)} fixed reference queries')
