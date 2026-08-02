# AI and music — index and quick reference

**TL;DR for the assistant:** This is the entry point to an eight-file knowledge base on AI and music, current to **2 August 2026**. Use the routing table to pick a file, the fast facts to sound specific, and the glossary to decode whatever the panel just said. If you only remember one thing: the supply of AI music has exploded (more than half of all new uploads to Deezer), the demand has not (1–3% of streams), and almost every fight in the room is really an argument about who gets paid for the gap.

---

## Read this aloud (10 lines of orientation)

1. AI music stopped being a demo and became an industry in about eighteen months: Suno is worth 5.4 billion dollars, has two million paying subscribers, and generates roughly seven million songs a day.
2. The volume is genuinely unprecedented — more than half of everything newly uploaded to Deezer is now fully machine-generated, around ninety thousand tracks every day.
3. But listeners have not followed. Those tracks take only one to three percent of actual streams, and up to eighty-five percent of the streams they do get are fraudulent.
4. The record industry's response split in two: sue, then settle. Universal settled with Udio, Warner settled with Suno, and Klay signed all three majors before it shipped anything. Sony is still litigating.
5. The law is unsettled and contradictory. A Munich court ruled two days ago that Suno's models memorised copyrighted songs and infringed; a London court held last November that Stable Diffusion's weights never contained copies at all.
6. No United States court has yet ruled on fair use in a music case, and none will before April 2027 — but since a hacker leaked Suno's source code in July, naming YouTube Music, Deezer and Genius as training sources, provenance is no longer something anyone has to infer.
7. Meanwhile the United States Copyright Office says prompts alone don't make you an author — so a track generated end to end from one line of text has no copyright at all, and anyone can copy it.
8. The technology moved from prompt-to-song toward stems, editing, real-time steering and DAW plug-ins, which is also where working musicians actually adopted it: seventy-one percent use stem separation, under a quarter use full song generation.
9. Culturally the argument is older than the technology — the talkies, the drum machine, sampling, Auto-Tune — but the difference this time is that the models are trained on the specific work of the people they displace.
10. And Japan is the most interesting room in the world to hold this conversation in: the G7's most permissive training rule, a twenty-year-old love affair with a synthetic singer, and a collecting society now campaigning to change the law.

---

## Routing table — which file to open

| File | What it covers | Reach for it when the question is about... |
|---|---|---|
| [`01-generative-music-landscape.md`](01-generative-music-landscape.md) | Products, companies, valuations, licensing deals, model capabilities and pricing as of Aug 2026 | Suno, Udio, Klay, ElevenLabs, Lyria, Stable Audio, ACE-Step, Mureka; "who's winning"; how much it costs; what the tools can actually do; the label settlements; walled gardens; "is there an OpenAI music model" |
| [`02-law-copyright-litigation.md`](02-law-copyright-litigation.md) | Every live case, statute and regulator position worldwide | Lawsuits, fair use, the four factors, who owns AI output, whether training needs a licence, voice-cloning law, deepfakes, ELVIS Act, NO FAKES Act, EU AI Act, Japan's Article 30-4, China labelling rules, statutory damages, "is my AI song copyrightable"; the leaked Suno source code and what it names |
| [`03-industry-economics-platforms.md`](03-industry-economics-platforms.md) | Money, streaming platforms, detection, fraud, royalty forecasts | Royalties, payouts, pro-rata vs user-centric, Spotify/Deezer/Apple/YouTube policy, AI detection and tagging, streaming fraud and bot farms, chart-topping AI acts and the IFPI chart-eligibility principles, sync and library revenue, market forecasts |
| [`04-artists-practice-backlash.md`](04-artists-practice-backlash.md) | What musicians actually do and say — adoption data, protest, organising | Holly Herndon, Grimes, Nick Cave, Imogen Heap, Brian Eno, Timbaland; the silent album; open letters; Fairly Trained; union action; survey data on what tools musicians use and refuse |
| [`05-technical-foundations.md`](05-technical-foundations.md) | How the models work, how they're evaluated, why watermarking fails | "How does it actually work", tokens vs latents, diffusion, codecs, voice conversion pipelines, stem separation, transcription, FAD and benchmarks, watermark robustness, training-data disclosure, compute and energy cost (and why nobody publishes it) |
| [`06-performance-tools-cocreation.md`](06-performance-tools-cocreation.md) | Real-time and live use, DAW integration, virtual concerts, accessibility | Live performance, latency, Ableton/Logic/iZotope/Splice features, Magenta RealTime, Neutone, DJ tools, ABBA Voyage, Hatsune Miku concerts, disabled musicians, "what can I try tonight" |
| [`07-culture-authorship-labor.md`](07-culture-authorship-labor.md) | Meaning, authorship, historical precedent, labour, bias in the data | "Is it real art", intention and slop, the talkies / LM-1 / Amen break / Auto-Tune parallels, ghost artists and Perfect Fit Content, listener blind tests, which jobs are exposed, Global South under-representation, whether an AI record can win a Grammy |
| [`08-japan-asia-scene.md`](08-japan-asia-scene.md) | Japan, Korea, China — law, industry bodies, synthetic voice culture | Article 30-4 and JASRAC's amendment campaign, Japan's AI Promotion Act, Hatsune Miku and Vocaloid, Synthesizer V, NEUTRINO, CeVIO, SOUNDRAW, K-pop and Supertone, GLXE, China's labelling mandate, Tencent Music, ByteDance Seed-Music, Mureka |

Also in this folder: [`09-discussion-prompts.md`](09-discussion-prompts.md) — moderator questions, escalation ladders, devil's-advocate lines and scenarios, all cross-referenced back to these eight files.

---

## Fast facts — the 24 to cite

| # | Fact | Date | Source | File |
|---|---|---|---|---|
| 1 | Suno raised **$400m at a $5.4bn valuation**, on **2 million paid subscribers and ~$300m ARR** — subscribers doubled in three months | 3 Jun 2026 (subs 25 Feb 2026) | [Music Ally](https://musically.com/2026/06/04/suno-raises-400m-funding-and-teases-its-first-licensed-model/) · [TechCrunch](https://techcrunch.com/2026/02/27/ai-music-generator-suno-hits-2-million-paid-subscribers-and-300m-in-annual-recurring-revenue/) | 01 |
| 2 | **Warner settled with Suno** — the first major-label deal — and *sold Songkick to Suno* as part of it; downloads became paid-only with monthly caps, artists get opt-in over name, image, likeness and voice | 25 Nov 2025 | [MBW](https://www.musicbusinessworldwide.com/warner-music-group-settles-with-suno-strikes-first-of-its-kind-deal-with-ai-song-generator/) | 01 |
| 3 | **GEMA beat Suno in Munich** (42 O 763/25): six songs found reproducibly present in Suno v3.5 and v4; the court took jurisdiction over the *US* training and held **all four US fair use factors against Suno** | 31 Jul 2026 | [Munich court PR 16/2026](https://www.justiz.bayern.de/gerichte-und-behoerden/landgericht/muenchen-1/presse/2026/16.php) | 02 |
| 4 | Anthropic settled the book-piracy class for **$1.5 billion** — roughly $3,000 per work across ~500,000 works, the largest copyright settlement in history | Final approval 2026 | [JURIST](https://www.jurist.org/news/2026/07/judge-approves-record-1-5-billion-settlement-involving-anthropic/) | 02 |
| 5 | US Copyright Office, Part 2: **"prompts alone do not provide sufficient human control to make users of an AI system the authors of the output."** A one-line-prompt track has no US copyright | 29 Jan 2025 | [Report PDF](https://www.copyright.gov/ai/Copyright-and-Artificial-Intelligence-Part-2-Copyrightability-Report.pdf) | 02 |
| 6 | **EU AI Act enforcement powers go live today** — fines up to **€15m or 3% of worldwide turnover** for GPAI transparency breaches; Article 50 labelling duties also apply from this date | 2 Aug 2026 | [GPAI guidelines](https://digital-strategy.ec.europa.eu/en/policies/guidelines-gpai-providers) | 02 |
| 7 | Fully AI-generated tracks passed **50% of Deezer's daily uploads — about 90,000 a day** — yet took only **1–3% of streams**, and **up to 85%** of streams on those tracks were fraudulent | 21 Jul 2026 | [Deezer](https://newsroom-deezer.com/2026/07/ai-music-exceeds-50-percent-daily-uploads-deezer/) | 03 |
| 8 | Spotify paid the industry **$11 billion in 2025** (~$70bn all-time) and its **100,000th-ranked artist earned $7,300** — up from about $350 in 2015 | Mar 2026 | [Loud & Clear](https://loudandclear.byspotify.com/takeaways/) | 03 |
| 9 | First US AI streaming-fraud conviction: Michael Smith agreed to forfeit **$8,091,843.64**; his bot farm was engineered for **661,440 streams a day** across hundreds of thousands of AI tracks | 19 Mar 2026 | [DOJ](https://www.justice.gov/usao-sdny/pr/north-carolina-man-pleads-guilty-music-streaming-fraud-aided-artificial-intelligence-0) | 03 |
| 10 | *Is This What We Want?* — a **silent album by 1,000+ UK artists** (Kate Bush, Damon Albarn, Annie Lennox, Hans Zimmer) protesting the UK opt-out plan — reached **No. 38** on the UK albums chart; the track titles spell out a sentence | 25 Feb 2025 | [isthiswhatwewant.com](https://www.isthiswhatwewant.com/) | 04 |
| 11 | Musicians adopt AI for chores, not composition: **71% use stem separation, 32% mastering, 24% full song generation** | late 2025 | [Moises × Water & Music](https://moises.ai/insights/musician-ai-report-water-and-music/) | 04 |
| 12 | Why long-form suddenly worked: MusicGen's codec produced **200 tokens per second** (a 6-minute song ≈ 72,000–144,000 tokens); Stable Audio 3's autoencoder produces **~10.76 latents per second** (~4,100 for the same song) — a 20–40× cut that a diffusion transformer can attend over all at once | Jun 2023 / May 2026 | [MusicGen](https://arxiv.org/abs/2306.05284) · [Stable Audio 3](https://arxiv.org/abs/2605.17991) | 05 |
| 13 | Audio watermarking does not survive contact with reality: a systematisation of knowledge tested **9 schemes against 22 attacks in 109 configurations and found none robust**; neural codecs and denoisers drive detection to near zero | 2025 / Apr 2025 | [SoK](https://sokaudiowm.github.io/) · [arXiv 2504.10782](https://arxiv.org/abs/2504.10782) | 05 |
| 14 | **Magenta RealTime 2 hit ~200 ms control latency** — about 15× faster than v1 — and its 230M small model runs in real time on a MacBook Air | 4 Jun 2026 | [Magenta](https://magenta.withgoogle.com/magenta-realtime-2) | 06 |
| 15 | **ABBA Voyage grossed £104.34m in 2024** across **374 shows and 1.06m tickets** at over 90% capacity — a virtual concert with no generative AI in it at all | 1 Oct 2025 | [MBW](https://www.musicbusinessworldwide.com/abba-voyage-generated-113m-in-2024-as-demand-for-virtual-concert-series-stayed-strong-in-third-year/) | 06 |
| 16 | In a **9,000-person, 8-market blind test, 97% could not identify fully AI-generated tracks** — and **80% still want AI music labelled**, 69% want it paid less | 12 Nov 2025 | [Deezer/Ipsos](https://newsroom-deezer.com/2025/11/deezer-ipsos-survey-ai-music/) | 07 |
| 17 | **88% of consumers say they prefer human-made music — and the preference vanishes within 60 seconds of listening.** They remain 15–25% less willing to *endorse* it | 9 Jun 2026 | [Univ. of Dayton / *Psychology & Marketing*](https://udayton.edu/blogs/business/2026/26-music-ai-research.php) | 07 |
| 18 | CISAC projects **24% of music creators' revenue at risk by 2028** (€10bn cumulative) — concentrated as **~60% of music *library* revenue versus ~20% of streaming revenue** | Dec 2024 | [CISAC](https://www.cisac.org/Newsroom/news-releases/global-economic-study-shows-human-creators-future-risk-generative-ai) | 07 |
| 19 | **JASRAC is campaigning to amend Article 30-4**, asking for "the opportunity to choose" rather than a ban; its 2026 survey found **54% of Japanese music creators opposed** to their work being used for training, 20% supportive | 11 Jun 2026 | [JASRAC](https://www.jasrac.or.jp/aboutus/ai.html) · [Innovatopia](https://innovatopia.jp/tech-social/tech-social-news/108475/) | 08 |
| 20 | **IFPI rolled out global chart-eligibility principles for AI recordings worldwide** — proposed 29 July by eleven companies (the three majors plus Believe, BMG, Concord, Dirty Hit, Glassnote, HYBE, Mom+Pop, Partisan), adopted the next day: a charting record must be **"substantially human made,"** made with an authorised AI service, and labelled as AI to consumers. **Four days old — it retires any "the charts haven't decided" framing** | 29–30 Jul 2026 | [IFPI](https://www.ifpi.org/ifpi-rolls-out-global-principles-for-the-eligibility-of-recordings-developed-using-ai-in-official-music-charts-worldwide/) | 03 |
| 21 | **Suno's own source code leaked and names the scraping sources** — a hacker who breached Suno gave 404 Media internal code enumerating **2,013,545 clips / 113,879 hours from YouTube Music**, plus Pond5, Genius, Deezer, Jamendo, Freesound and ~420,000 podcasts. Suno called it "outdated source code"; it has conceded since 2024 that it trained on copyrighted recordings. **Provenance is no longer something the labels have to infer** | 15 Jul 2026 | [404 Media](https://www.404media.co/hack-reveals-suno-ai-music-generator-scraped-youtube-deezer-and-genius/) | 02 |
| 22 | **An AI record can win a Grammy — the AI cannot.** The Recording Academy rule, carried unchanged into the 69th Grammy rulebook: "Only human creators are eligible… A work that contains no human authorship is not eligible in any categories." Human authorship must be **"meaningful and more than de minimis"** *and relevant to the category entered* — songwriting entries need it in the music or lyrics, performance entries in the performance | Rulebook 11 Jun 2026 | [69th Rulebook](https://ra-grammy-media.ncp.consulting/uploads/2026/06/69_Rulebook_06112026-FINAL2.pdf) | 07 |
| 23 | **Nobody in music generation publishes energy numbers** — no compute or carbon section in Meta's MusicGen model card, none in the Stable Audio 3 paper, nothing from Suno, Udio or Lyria, and music is not among the ten tasks Hugging Face's AI Energy Score rates. Any per-track figure quoted on stage, including yours, is derived from GPU specs rather than measured. Say so when challenged | Aug 2026 | [AI Energy Score](https://huggingface.github.io/AIEnergyScore/) | 05 |
| 24 | **Magical Mirai has drawn over 580,000 people since 2013** (85,000+ in 2025 alone) and **Hatsune Miku V6 shipped 14 April 2026** — so "audiences will never accept a synthetic singer" is not an argument that works in Tokyo | Mar 2026 / 14 Apr 2026 | [Crypton](https://www.crypton.co.jp/cfm/news/2026/03/09miku20th) · [Miku V6](https://www.crypton.co.jp/cfm/news/2026/02/18miku_v6) | 08 |

**Three more worth having in your pocket:** the Munich ruling that a model's parameters *contain* a reproduction ([GEMA v. OpenAI, 11 Nov 2025](https://www.insidetechlaw.com/blog/2025/11/germany-delivers-landmark-copyright-ruling-against-openai-what-it-means-for-ai-and-ip)) sits in direct technical tension with London's holding that Stable Diffusion's weights **"at no point contained copies"** ([Getty v. Stability, 4 Nov 2025](https://www.judiciary.uk/wp-content/uploads/2025/11/Getty-Images-v-Stability-AI.pdf)); only **5.7% of the hours** in music-generation training data come from non-Western genres ([Music for All, Feb 2025](https://arxiv.org/abs/2502.07328)); and **HYBE resolved to liquidate Supertone** after investing about **US$35m** ([15 Jul 2026](https://www.musicbusinessworldwide.com/hybe-winds-down-ai-voice-company-supertone-after-investing-nearly-35m/)).

---

## Glossary — 28 terms the panel might use

**Neural audio codec** — a learned compressor (SoundStream, EnCodec, DAC) that turns waveforms into a short sequence of discrete tokens and back; it is what makes music generation tractable for a transformer at all.

**RVQ (residual vector quantization)** — the trick inside those codecs: several stacked codebooks where each one encodes what the previous one got wrong, so quality scales with how many codebooks you decode.

**Token rate** — how many symbols per second a model must emit; MusicGen's 200/sec mono is why early token models capped out around 30 seconds of real context.

**Latent diffusion** — instead of generating audio sample by sample, the model denoises a compressed "latent" representation and decodes it once at the end; this is how six-minute songs became fast.

**Diffusion transformer (DiT)** — a transformer that does the denoising in a diffusion model, letting it attend over an entire song at once rather than sliding a window.

**Flow matching** — a training objective that learns a straight-line path from noise to data, giving diffusion-style quality in far fewer sampling steps.

**Autoregressive (AR) vs non-autoregressive** — AR models predict the next token one at a time (slow, good at long-range structure); masked or parallel decoders like MAGNeT fill in many tokens at once and run several times faster.

**Stem** — one isolated layer of a mix (vocals, drums, bass, other); "stems" is also the industry shorthand for whether an AI tool gives you editable parts or just a bounced mix.

**Source separation** — pulling stems back out of a finished stereo mix (Spleeter, Demucs, BS-RoFormer); the single most widely adopted AI feature among working musicians.

**Inpainting / outpainting** — regenerating a selected region inside an existing track, or extending it past its ends, instead of generating from scratch.

**LoRA fine-tune** — a small adapter trained on a handful of examples to bend a big model toward one style or voice; specifically flagged by Japan's Cultural Affairs guidance as the case where the training exception can fail.

**SVC (singing voice conversion)** — a pipeline that keeps the melody and words of a performance but replaces the timbre with someone else's voice, typically content encoder plus pitch tracker plus vocoder.

**RVC (Retrieval-based Voice Conversion)** — the most popular open-source SVC tool; it adds a retrieval index over the target singer's features to keep the output sounding like that person rather than an average.

**VOCALOID / VOCALOID:AI** — Yamaha's singing-synthesis engine and its neural successor; the technology under Hatsune Miku, where the voice is a licensed recording of a consenting actress and a human writes every song.

**FAD (Fréchet Audio Distance)** — the standard automatic score for generated audio: how far the distribution of embeddings for your output sits from a reference set. Notoriously sensitive to which embedding model and which reference set you pick.

**MusicCaps** — the field's main text-to-music benchmark, 5,521 ten-second clips with human captions; small enough that overfitting to it is a real risk.

**MOS (mean opinion score)** — a human listening test; the honest alternative to FAD, and the reason most published comparisons are not reproducible.

**SynthID** — Google's imperceptible watermark, applied to all Lyria output; there is no public detector, and no law names it.

**C2PA / Content Credentials** — an open standard for cryptographically signed provenance metadata attached to a file; survives well until someone re-encodes or re-records the audio.

**DDEX** — the music industry's metadata standard body; the channel through which distributors now pass "this release used AI" disclosure flags to streaming services.

**TDM exception** — a copyright carve-out permitting text and data mining; the EU's version has an opt-out for rightsholders, the UK's is research-only, Japan's has neither.

**Article 30-4** — Japan's TDM provision (in force 2019), which permits even commercial training where the purpose is not to "enjoy" the expression; no opt-out, no lawful-source requirement, narrowed in practice by the Cultural Affairs guidance of 15 March 2024.

**Fair use / the four factors** — the US defence under 17 U.S.C. §107, weighing purpose, nature, amount and market effect; no US court has yet applied it to music AI, though the Munich court applied it to Suno and found all four against.

**Market dilution** — the theory Judge Chhabria floated in *Kadrey v. Meta*: harm not from copying your song but from flooding the market with cheap substitutes for it. Currently rightsholders' most promising factor-four argument.

**Digital replica / right of publicity** — the legal interest in your own voice and likeness, protected patchily by US state law (Tennessee's ELVIS Act is the strongest) and not yet federally.

**Pro-rata vs user-centric** — how streaming money is split: pro-rata pools everyone's subscriptions and divides by total stream share (which is what makes upload-flooding profitable); user-centric divides *your* subscription among only the artists *you* played.

**Sync licensing** — licensing music for use in film, TV, ads and games; the one IFPI revenue line that shrank in 2025, and the market most directly exposed to cheap generated cues.

**Production / library music** — pre-cleared functional music sold for media use; anonymous, work-for-hire, and the epicentre of projected AI displacement at roughly 60% of that revenue by 2028.

**Perfect Fit Content** — Spotify's programme of commissioning cheap functional music for mood playlists at better margins; proof the demand for authorless background music was manufactured before AI could supply it.

**"New use" (AFM Article 21)** — the collective-bargaining clause requiring extra payment when a recording is exploited in a way not covered by the original session; the basis of the American Federation of Musicians' 2026 suit against Universal and Warner.
