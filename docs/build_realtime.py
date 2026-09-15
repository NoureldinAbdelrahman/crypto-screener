#!/usr/bin/env python3
"""Build the real-time Drift Fund screener (index.html).

Data sources:
  - Binance WebSocket (!miniTicker@arr)  -> live price / 24h change / volume
  - Binance REST (/ticker/24hr, /ticker?windowSize=) -> snapshot + small timeframes
  - CoinGecko REST (/coins/markets)      -> name / icon / market cap + non-Binance coins

Run:  python3 build_realtime.py
"""

import json
import urllib.request
import urllib.error
from pathlib import Path

HERE = Path(__file__).parent
DRIFTFUND_FILE = HERE / "driftfund_instruments.txt"
OUTPUT = HERE / "index.html"

# Tickers in the Drift Fund "crypto" section that are really stocks / ETFs / companies.
NON_CRYPTO = {
    "GOOGL", "PLTR", "HIMS", "HOOD", "ISRG", "RKLB", "TWLO", "WDC", "GME",
    "SOXL", "URNM", "USO", "QQQ", "SPX", "XLE", "ASTS", "IREN", "NBIS", "RDW",
    "BMNR", "CRWV", "CBRS", "CGNX", "CRDO", "FLNC", "GEV", "LUNR", "PROS",
    "RAVE", "RLS", "ROK", "SHLD", "SPACE", "SPCX", "SKHYNIX", "SNDK", "SLX",
    "TRUST", "USAR", "WET", "NOW", "LAB", "OF", "OFC", "ANTHROPIC", "OPENAI",
    "DRAM", "INFQ", "ACU", "AZTEC", "BASED", "BEAT", "BLEND", "BREV", "BSB",
    "CHIP", "COAI", "DOOD", "EDGE", "ENSO", "KGEN", "LIGHT", "MON", "PIEVERSE",
    "STABLE", "TRIA", "TRUTH", "ZBT", "ZAMA", "MMT", "STRIKE", "RECALL",
}

# Non-Binance crypto symbols that should still be shown (priced via CoinGecko).
# Only these are considered; anything else not on Binance is dropped as non-crypto noise.
CG_CANDIDATES = {
    "BRETT", "CRO", "FARTCOIN", "GRASS", "HYPE", "ICX", "LRC", "MEW",
    "MOODENG", "OKB", "POPCAT", "TON", "ZETA", "ZORA", "MERL", "PIPPIN",
    "CORE", "USELESS", "SOON", "RIVER", "SATS", "HMSTR", "BICO", "BIGTIME",
    "BOME", "BSV", "ETC", "TURBO", "PNUT", "PEOPLE", "MEME", "WIF", "BONK",
    "FLOKI", "PENGU", "TRUMP", "NEIRO", "ORDI", "KAITO", "PLUME", "AERO",
    "AEVO", "LAYER", "SYRUP", "WCT", "VIRTUAL", "VANA", "MOVE", "LINEA",
    "KMNO", "PARTI", "KITE", "SAPIEN", "SIGN", "SOPH", "PROVE", "OPN",
}

OVERRIDES = {
    "BTC": "bitcoin", "ETH": "ethereum", "DOGE": "dogecoin", "SOL": "solana",
    "XRP": "ripple", "ADA": "cardano", "AVAX": "avalanche-2", "DOT": "polkadot",
    "LINK": "chainlink", "UNI": "uniswap", "AAVE": "aave", "ATOM": "cosmos",
    "LTC": "litecoin", "BCH": "bitcoin-cash", "XLM": "stellar", "NEAR": "near",
    "APT": "aptos", "ARB": "arbitrum", "OP": "optimism", "SUI": "sui",
    "SEI": "sei-network", "TON": "the-open-network", "TRX": "tron",
    "FIL": "filecoin", "ICP": "internet-computer", "HBAR": "hedera-hashgraph",
    "ALGO": "algorand", "SUSHI": "sushi", "COMP": "compound-governance-token",
    "MKR": "maker", "YFI": "yearn-finance", "SNX": "havven",
    "CRV": "curve-dao-token", "1INCH": "1inch", "GRT": "the-graph",
    "USDC": "usd-coin", "ENJ": "enjincoin", "BAT": "basic-attention-token",
    "CHZ": "chiliz", "MANA": "decentraland", "SAND": "the-sandbox",
    "AXS": "axie-infinity", "FLOW": "flow", "MINA": "mina-protocol",
    "EGLD": "multiversx-egld", "THETA": "theta-token", "XTZ": "tezos",
    "VET": "vechain", "TRB": "tellor", "QTUM": "qtum", "ZEC": "zcash",
    "DASH": "dash", "LRC": "loopring", "LPT": "livepeer", "ZRX": "0x",
    "DYDX": "dydx", "LUNA": "terra-luna-2", "NEO": "neo", "GALA": "gala",
    "ZIL": "zilliqa", "ICX": "icon", "IOTA": "iota", "ONT": "ontology",
    "RVN": "ravencoin", "XMR": "monero", "STX": "blockstack", "CELO": "celo",
    "KSM": "kusama", "FLOKI": "floki", "BONK": "bonk", "PEPE": "pepe",
    "WIF": "dogwifhat", "SHIB": "shiba-inu", "WLD": "worldcoin-wld",
    "TAO": "bittensor", "HYPE": "hyperliquid", "ENA": "ethena",
    "PENDLE": "pendle", "LDO": "lido-dao", "SSV": "ssv-network",
    "MASK": "mask-network", "RENDER": "render-token", "IMX": "immutable-x",
    "GMT": "stepn", "JUP": "jupiter-exchange-solana", "JTO": "jito-governance-token",
    "RAY": "raydium", "WOO": "woo-network", "INJ": "injective-protocol",
    "BAND": "band-protocol", "NMR": "numeraire", "UMA": "uma", "API3": "api3",
    "OKB": "okb", "GAS": "gas", "GLM": "golem", "QNT": "quant-network",
    "PENGU": "pudgy-penguins", "MOODENG": "moo-deng", "BOME": "book-of-meme",
    "ORDI": "ordinals", "SATS": "sats-ordinals", "TRUMP": "official-trump",
    "MEW": "cat-in-a-dogs-world", "MEME": "memecoin", "PEOPLE": "constitutiondao",
    "STRK": "starknet", "ZK": "zksync", "ZRO": "layerzero", "PYTH": "pyth-network",
    "ONDO": "ondo-finance", "BLUR": "blur", "AGLD": "adventure-gold",
    "BIGTIME": "big-time", "LQTY": "liquity", "OCEAN": "ocean-protocol",
    "BAL": "balancer", "RUNE": "thorchain", "KAVA": "kava", "XEM": "nem",
    "WAVES": "waves", "SC": "siacoin", "DCR": "decred", "LSK": "lisk",
    "ARK": "ark", "KNC": "kyber-network-crystal", "CVC": "civic",
    "STORJ": "storj", "OXT": "orchid-protocol", "NKN": "nkn", "XVG": "verge",
    "BTG": "bitcoin-gold", "STEEM": "steem", "NANO": "nano", "BTS": "bitshares",
    "PPT": "populous", "REQ": "request-network", "POWR": "power-ledger",
    "WTC": "waltonchain", "PIVX": "pivx", "VTC": "vertcoin", "DGB": "digibyte",
    "RDD": "reddcoin", "PPC": "peercoin", "NMC": "namecoin", "ZEN": "horizen",
    "ZETA": "zetachain", "MERL": "merlin-chain", "POL": "polygon-ecosystem-token",
    "TIA": "celestia", "MORPHO": "morpho", "EIGEN": "eigenlayer",
    "INIT": "initia", "RESOLV": "resolv", "PUMP": "pump-fun",
    "PNUT": "peanut-the-squirrel", "FARTCOIN": "fartcoin",
    "NEIRO": "neiro-on-ethereum", "KAITO": "kaito", "PLUME": "plume",
    "AERO": "aerodrome-finance", "AEVO": "aevo-exchange", "ZORA": "zora",
    "MOVE": "movement", "VANA": "vana", "VIRTUAL": "virtual-protocol",
    "WCT": "wallet-connect-token", "SYRUP": "syrup-finance", "LINEA": "linea",
    "KMNO": "kamino", "PARTI": "particle-network", "KITE": "kite",
    "SAPIEN": "sapien", "SIGN": "sign", "SOPH": "sophon", "PROVE": "provenance",
    "OPN": "opennetwork", "USELESS": "useless", "CORE": "core-dao",
    "CRO": "crypto-com-chain", "BRETT": "based-brett", "GRASS": "grass",
    "ICX": "icon", "POPCAT": "popcat", "HMSTR": "hamster-kombat",
    "BICO": "biconomy", "TURBO": "turbo", "SOON": "soon", "RIVER": "river",
    "BSV": "bitcoin-cash-sv", "ETC": "ethereum-classic",
}


def parse_crypto_symbols():
    lines = DRIFTFUND_FILE.read_text().splitlines()
    syms, in_crypto = [], False
    for line in lines:
        x = line.strip()
        if x.startswith("CRYPTOCURRENCIES"):
            in_crypto = True
            continue
        if in_crypto:
            if x.startswith("STOCKS"):
                break
            if x.startswith("---") or x == "" or x in NON_CRYPTO:
                continue
            syms.append(x)
    return syms


def get(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {"User-Agent": "drift-screener/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def main():
    symbols = parse_crypto_symbols()
    print(f"Crypto symbols in Drift Fund list: {len(symbols)}")

    print("Fetching Binance exchange info...")
    info = get("https://api.binance.com/api/v3/exchangeInfo?permissions=SPOT")
    bases = {s["baseAsset"] for s in info["symbols"]
             if s["quoteAsset"] == "USDT" and s["status"] == "TRADING"}

    binance = {s: s + "USDT" for s in symbols if s in bases}
    non_binance = [s for s in symbols if s not in bases]
    print(f"On Binance: {len(binance)} | not on Binance: {len(non_binance)}")

    print("Fetching CoinGecko coin list...")
    cg_list = get("https://api.coingecko.com/api/v3/coins/list")
    by_sym = {}
    for c in cg_list:
        by_sym.setdefault(c["symbol"].upper(), []).append(c["id"])

    df_to_cg = {}
    for s in symbols:
        if s in OVERRIDES:
            df_to_cg[s] = OVERRIDES[s]
        elif s in by_sym:
            # prefer the shortest id (usually the canonical coin)
            df_to_cg[s] = sorted(by_sym[s], key=len)[0]

    cg_only = {s: df_to_cg[s] for s in non_binance if s in CG_CANDIDATES and s in df_to_cg}
    print(f"CoinGecko-fallback coins: {len(cg_only)} -> {', '.join(cg_only)}")

    html = (HERE / "template.html").read_text()
    html = html.replace("__BINANCE_JSON__", json.dumps(binance, separators=(",", ":")))
    html = html.replace("__CG_ONLY_JSON__", json.dumps(cg_only, separators=(",", ":")))
    html = html.replace("__DF_TO_CG_JSON__", json.dumps(df_to_cg, separators=(",", ":")))
    OUTPUT.write_text(html)

    total = len(binance) + len(cg_only)
    print(f"Wrote {OUTPUT} with {total} coins ({len(binance)} live Binance + {len(cg_only)} CoinGecko).")


if __name__ == "__main__":
    main()
