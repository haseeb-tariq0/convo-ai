"""Phone number → country derivation.

Ported from the Rove Apps Script's `getCountryFromPhone` + `COUNTRY_CODES`
table. Mohsin asked for this in the May 20 meeting — WhatsApp rows carry
`User Phone` with an E.164-ish prefix (e.g. `971508192479` for UAE), and
the script derives country by longest-prefix match (4 → 1 digit) against
a ~200-country phone-code table.

We store ISO-3166 alpha-2 codes (`AE`, `SA`, …) instead of the script's
full-name strings so the bubble map's coordinate lookup can stay keyed
on ISO codes (matches the GA4 sync). One-call multi-country prefixes
(`+1` = USA/Canada, `+7` = Russia/Kazakhstan) collapse to the dominant
country.
"""
from __future__ import annotations

import re

# Phone country code → ISO-3166 alpha-2. Verbatim port of the Apps Script's
# COUNTRY_CODES table, converted from country names to ISO codes.
PHONE_TO_ISO: dict[str, str] = {
    "1": "US",   "7": "RU",   "20": "EG",  "27": "ZA",  "30": "GR",
    "31": "NL",  "32": "BE",  "33": "FR",  "34": "ES",  "39": "IT",
    "40": "RO",  "41": "CH",  "43": "AT",  "44": "GB",  "45": "DK",
    "46": "SE",  "47": "NO",  "48": "PL",  "49": "DE",  "51": "PE",
    "52": "MX",  "53": "CU",  "54": "AR",  "55": "BR",  "56": "CL",
    "57": "CO",  "58": "VE",  "60": "MY",  "61": "AU",  "62": "ID",
    "63": "PH",  "64": "NZ",  "65": "SG",  "66": "TH",  "81": "JP",
    "82": "KR",  "84": "VN",  "86": "CN",  "90": "TR",  "91": "IN",
    "92": "PK",  "93": "AF",  "94": "LK",  "95": "MM",  "98": "IR",
    "212": "MA", "213": "DZ", "216": "TN", "218": "LY", "220": "GM",
    "221": "SN", "222": "MR", "223": "ML", "224": "GN", "225": "CI",
    "226": "BF", "227": "NE", "228": "TG", "229": "BJ", "230": "MU",
    "231": "LR", "232": "SL", "233": "GH", "234": "NG", "235": "TD",
    "236": "CF", "237": "CM", "238": "CV", "239": "ST", "240": "GQ",
    "241": "GA", "242": "CG", "243": "CD", "244": "AO", "245": "GW",
    "246": "IO", "248": "SC", "249": "SD", "250": "RW", "251": "ET",
    "252": "SO", "253": "DJ", "254": "KE", "255": "TZ", "256": "UG",
    "257": "BI", "258": "MZ", "260": "ZM", "261": "MG", "262": "RE",
    "263": "ZW", "264": "NA", "265": "MW", "266": "LS", "267": "BW",
    "268": "SZ", "269": "KM", "290": "SH", "291": "ER", "297": "AW",
    "298": "FO", "299": "GL", "350": "GI", "351": "PT", "352": "LU",
    "353": "IE", "354": "IS", "355": "AL", "356": "MT", "357": "CY",
    "358": "FI", "359": "BG", "370": "LT", "371": "LV", "372": "EE",
    "373": "MD", "374": "AM", "375": "BY", "376": "AD", "377": "MC",
    "378": "SM", "380": "UA", "381": "RS", "382": "ME", "383": "XK",
    "385": "HR", "386": "SI", "387": "BA", "389": "MK", "420": "CZ",
    "421": "SK", "423": "LI", "500": "FK", "501": "BZ", "502": "GT",
    "503": "SV", "504": "HN", "505": "NI", "506": "CR", "507": "PA",
    "508": "PM", "509": "HT", "590": "GP", "591": "BO", "592": "GY",
    "593": "EC", "594": "GF", "595": "PY", "596": "MQ", "597": "SR",
    "598": "UY", "599": "BQ", "670": "TL", "672": "AQ", "673": "BN",
    "674": "NR", "675": "PG", "676": "TO", "677": "SB", "678": "VU",
    "679": "FJ", "680": "PW", "681": "WF", "682": "CK", "683": "NU",
    "685": "WS", "686": "KI", "687": "NC", "688": "TV", "689": "PF",
    "690": "TK", "691": "FM", "692": "MH", "850": "KP", "852": "HK",
    "853": "MO", "855": "KH", "856": "LA", "880": "BD", "886": "TW",
    "960": "MV", "961": "LB", "962": "JO", "963": "SY", "964": "IQ",
    "965": "KW", "966": "SA", "967": "YE", "968": "OM", "970": "PS",
    "971": "AE", "972": "IL", "973": "BH", "974": "QA", "975": "BT",
    "976": "MN", "977": "NP", "992": "TJ", "993": "TM", "994": "AZ",
    "995": "GE", "996": "KG", "998": "UZ",
}

_DIGITS_RE = re.compile(r"\d+")


def country_iso_from_phone(phone_or_id: str | None) -> str | None:
    """Strip non-digits, then longest-prefix match (4 → 1) against
    `PHONE_TO_ISO`. Returns ISO alpha-2 or `None` if no match.

    Mirrors the Apps Script's `getCountryFromPhone` algorithm exactly —
    same prefix-length scan, same "non-digit chars get stripped" behavior.
    Pass session IDs through safely: a UUID has no recognizable prefix,
    so we return `None` (script returned 'Unknown' as a label string).
    """
    if not phone_or_id:
        return None
    # Strip everything except digits — same as the script's
    # `.replace(/[\s\-().]/g, '')` plus `.match(/\+?(\d{1,15})/)`.
    digits = "".join(_DIGITS_RE.findall(str(phone_or_id)))
    if not digits:
        return None
    for length in range(4, 0, -1):
        prefix = digits[:length]
        iso = PHONE_TO_ISO.get(prefix)
        if iso:
            return iso
    return None
