"""Rebuild the bounded, source-checked development dataset from official snapshots.

The user explicitly allowed AI-reviewed data for development on 2026-10-21.
This is not an independent human review or a claim about AI video production.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ANNOTATIONS = {
    45128: (["玄幻"], ["逆袭", "经营"], {}),
    102888: (["玄幻"], ["重生", "成长", "战斗"], {}),
    42977: (["玄幻"], ["战斗"], {}),
    102887: (["玄幻"], ["逆袭", "成长", "战斗"], {}),
    28092: (["武侠", "古风"], ["穿越", "冒险"], {}),
    103017: (["玄幻"], ["逆袭", "成长"], {}),
    102867: (["都市", "修仙"], [], {}),
    32556: (["武侠", "恋爱"], ["成长", "冒险"], {"romance": True}),
    32430: (["玄幻", "武侠"], ["冒险", "战斗"], {}),
    102998: (["修仙"], ["穿越"], {}),
    100171: (["玄幻"], [], {}),
    102872: (["末世"], [], {}),
    102894: (["修仙"], ["重生", "复仇"], {}),
    43048: (["玄幻"], ["成长", "冒险"], {}),
    113970: (["玄幻"], ["系统", "成长"], {}),
    102999: (["修仙"], ["重生", "经营", "战斗"], {}),
    149531: (["玄幻"], ["重生", "系统", "成长"], {}),
    102892: (["修仙", "都市"], ["重生"], {}),
    149526: (["玄幻"], ["重生", "治愈", "战斗"], {}),
    45991: (["玄幻"], ["经营", "冒险"], {"romance": True}),
    121468: (["玄幻"], ["系统", "成长", "冒险"], {}),
    88987: ([], ["重生", "复仇"], {}),
    102829: (["都市", "修仙"], ["重生", "复仇"], {"romance": True}),
    149530: (["玄幻"], ["穿越", "系统"], {"tragic": True}),
    102864: (["修仙", "恋爱"], [], {"romance": True}),
    148585: (["玄幻"], ["穿越", "系统"], {}),
    149529: (["玄幻", "修仙"], ["穿越", "系统", "复仇"], {}),
    33874: (["武侠", "恋爱"], ["成长", "冒险"], {"romance": True}),
    103000: (["武侠"], ["穿越", "逆袭"], {}),
    102995: (["玄幻"], ["穿越", "重生"], {}),
    103003: ([], ["系统", "逆袭"], {"romance": True}),
    111618: (["玄幻"], ["重生", "复仇", "战斗", "成长"], {}),
    112207: (["玄幻"], ["穿越", "战斗"], {}),
    102893: (["都市", "修仙"], ["系统"], {}),
    149520: (["末世"], ["系统", "战斗"], {}),
    103007: (["修仙", "搞笑"], ["战斗"], {}),
}


def prepare(rows):
    result = []
    for row in rows:
        sid = int(row["id"].split("-")[1])
        genres, themes, facts = ANNOTATIONS[sid]
        intro = row["original_intro"]
        summary = intro.split("。", 1)[0][:140] + ("。" if "。" in intro else "")
        evidence = [{"id": "summary-1", "field": "summary", "quote": summary.rstrip("。") if summary not in intro else summary}]
        for field, value in {"genres": genres, "themes": themes, **facts}.items():
            if value is not None and value != []:
                evidence.append({"id": f"{field}-1", "field": field, "quote": intro[:900]})
        result.append({**row, "summary": summary, "genres": genres, "themes": themes,
                       "pace": None, "harem": None, "romance": None, "tragic": None, **facts,
                       "evidence": evidence, "review_status": "approved",
                       "review_note": "AI 逐条对照官方简介核对；用户已允许用于开发验证。待独立人工复核，不能作为正式审核结论。作品是否采用 AI 制作未知。"})
    return result


if __name__ == "__main__":
    source = ROOT / "data/source-cache/official.json"
    rows = json.loads(source.read_text(encoding="utf-8"))
    result = prepare(rows)
    (ROOT / "data/works.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Prepared {len(result)} source-checked development works")
