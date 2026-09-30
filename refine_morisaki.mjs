import { readFileSync, writeFileSync } from 'node:fs';

const refineMorisaki = (en) => {
  let refined = en;

  // Preserve markup and line breaks
  const prefix = refined.match(/^(<br\/>\s*|\\r\\n\s*)*/)?.[0] || '';
  let text = refined.substring(prefix.length);

  // High-level prose improvements
  text = text.replace(/It was from the beginning of summer until the early spring of the following year that I lived at the Morisaki Bookshop\./, "I lived at the Morisaki Bookshop from the beginning of summer until the following spring.");
  text = text.replace(/During that time, I spent my days in a vacant room on the second floor of the shop, practically buried in books\./, "I spent those months in a spare room on the second floor, practically buried in books.");
  text = text.replace(/The room had poor sunlight and was cramped; moreover, it was always damp and surrounded by the musty smell of old books\./, "The room was cramped and poorly lit, always damp and smelling of old books.");
  text = text.replace(/But to this day, I have never once forgotten the days I spent there\./, "But to this day, I have never once forgotten the time I spent there.");
  text = text.replace(/That's because that place gave me the chance to start my real life\./, "That's because it was that place that gave me the chance to start my real life.");
  text = text.replace(/If those days hadn't happened, my life afterwards would surely have been more colorless, monotonous, and lonely\./, "If I hadn't spent those days there, my life would surely have been far more colorless, monotonous, and lonely.");
  text = text.replace(/The whole thing started as a bolt from the blue\./, "It all started with a bolt from the blue.");
  text = text.replace(/No, for me, it was a fact even more surprising than frogs falling from the sky\./, "Actually, for me, it was more shocking than if frogs had started falling from the sky.");
  text = text.replace(/That day, Hideaki, my boyfriend of one year, suddenly said, "I'm getting married\."/, "That day, Hideaki, my boyfriend of a year, suddenly said, \"I'm getting married.\"");
  text = text.replace(/When I first heard that, my head was filled with "\?"/, "When I first heard it, my head was filled with nothing but question marks.");
  text = text.replace(/I mean, if it were "Let's get married," I'd understand\./, "If he'd said \"Let's get married,\" I'd have understood.");
  text = text.replace(/Even "I want to get married" would still convey a meaning\./, "Even \"I want to get married\" would have meant something.");
  text = text.replace(/But saying "I am getting married" is absolutely strange\./, "But \"I'm getting married\" made absolutely no sense.");
  text = text.replace(/Since marriage is a vow established based on mutual consent, it's completely wrong as a way of using words\./, "Marriage is a vow made between two people; his choice of words was fundamentally wrong.");
  text = text.replace(/And besides, what was with that light tone of voice\?/, "And what was with that casual tone?");
  text = text.replace(/His tone was as blunt as saying, "I found a hundred yen on the side of the road\."/, "He sounded as indifferent as if he'd just found a hundred yen on the sidewalk.");
  
  // Satoru's dialogue
  text = text.replace(/Takako-chan, how are you doing\?/, "Takako-chan, how are things?");
  text = text.replace(/It's me, Satoru\./, "It's me, Satoru!");
  text = text.replace(/I'm calling from the bookstore now\./, "I'm calling from the shop.");
  text = text.replace(/It can be later, but please get in touch\./, "Give me a call when you can.");
  text = text.replace(/Oops, a customer just came in\./, "Oops, a customer. Gotta go.");
  text = text.replace(/Well, see you later!/, "Talk soon!");

  // General refinements for flow
  text = text.replace(/It was a Friday evening in mid-June\./, "It was a Friday evening in the middle of June.");
  text = text.replace(/Just being with him made my heart bounce like a trampoline\./, "Just being with him made my heart skip like a trampoline.");
  text = text.replace(/At his words, I involuntarily asked back, "Huh\?"/, "I couldn't help but ask, \"Huh?\"");
  text = text.replace(/I thought I had misheard\./, "I thought I'd heard him wrong.");
  text = text.replace(/But he calmly repeated the same words once more:/, "But he just calmly repeated himself:");
  text = text.replace(/"So, it's been decided that I'm getting married next year\."/, "\"So, I'm getting married next year.\"");
  text = text.replace(/"Me and my girlfriend\."/, "\"Me and my girlfriend.\"");
  text = text.replace(/I tilted my head again\./, "I was still confused.");
  text = text.replace(/Then, to my disbelief, he mentioned the name of a girl who worked in another department at our office, without looking the least bit ashamed\./, "Then, to my disbelief, he named a girl from another department without a hint of shame.");
  text = text.replace(/She was in the same cohort as me, a girl with such a cute aura that even another woman would want to give her a tight squeeze\./, "She was in my year, a girl with such a cute aura that even another woman would want to give her a hug.");
  text = text.replace(/In comparison, I was on the taller side, and my appearance was ordinary\./, "Compared to her, I was tall and plain-looking.");
  text = text.replace(/I couldn't understand his feelings—why he thought of making a move on me while dating such a cute girl\./, "I couldn't understand why he'd even bother with me when he was already dating someone so cute.");
  text = text.replace(/As it turned out, the two of them had been dating since about two and a half years ago\./, "It turned out they'd been together for two and a half years.");
  text = text.replace(/In other words, they had been together longer than we had\./, "Which meant they'd been together much longer than we had.");
  text = text.replace(/Of course, I didn't know he was dating someone else, nor had I ever suspected it or even considered the possibility\./, "I hadn't a clue he was seeing someone else. It never even crossed my mind.");
  text = text.replace(/Our relationship was a secret within the company, but I had just assumed it was because he didn't want things to be awkward at the office\./, "I'd assumed we were keeping our relationship a secret just to avoid any awkwardness at work.");
  text = text.replace(/But for him, I was never the main interest; I was just someone to play around with\./, "But for him, I was never the real thing—just someone to pass the time with.");
  text = text.replace(/Was I dull, or was he crazy\?/, "Was I just blind, or was he insane?");
  text = text.replace(/Anyway, the two had already introduced each other to their parents, and they were even going to finish the formal engagement ceremony next month\./, "They'd already met each other's parents and were set for the formal engagement next month.");
  text = text.replace(/My head spun\./, "My head was spinning.");
  text = text.replace(/It felt as if a monk was striking a great bell—gong—inside my head\./, "It felt like a temple bell was ringing inside my skull.");
  text = text.replace(/"She wouldn't listen and insisted the ceremony had to be in June, you see\./, "\"She's insisted on a June wedding, you see.");
  text = text.replace(/But you see, there"s no way we could make it in time for this year, right\?/, "But there was no way we could pull it off this year.");
  text = text.replace(/I listened vacantly to those kinds of words falling from his mouth\./, "I just sat there, vacantly listening to him talk.");
  text = text.replace(/And I just muttered a single sentence: "I see, good for you\."/, "And I managed to mutter a single sentence: \"I see. Good for you.\"");
  text = text.replace(/Even I was surprised by my own words\./, "I was surprised the words even came out.");
  text = text.replace(/"Yeah, thanks\./, "\"Yeah, thanks!");
  text = text.replace(/But well, I can still see you once in a while, Takako," Hideaki said with a broad grin\./, "But hey, I can still see you once in a while, Takako,\" Hideaki said with a grin.");
  text = text.replace(/It was his usual carefree, characteristically athletic smile\./, "It was that same carefree, athletic smile of his.");
  text = text.replace(/If this were a melodrama, I probably would have stood up and thrown wine at him right then\./, "If this were a movie, I'd have probably thrown my wine in his face.");
  text = text.replace(/But I've always been bad at showing my emotions, and I have the kind of temperament where I don't even know what I'm thinking until I'm alone and can think it over thoroughly\./, "But I've always been bad at showing my feelings. I'm the type who doesn't even know what I'm thinking until I'm alone and can process everything.");
  text = text.replace(/Besides, at that moment, the monk's bell was way too loud\./, "Besides, that bell in my head was still ringing too loudly.");
  text = text.replace(/Parting from him in a daze, I returned alone to my apartment\./, "I left him in a daze and walked back to my apartment alone.");
  text = text.replace(/Eventually, as my head cleared little by little, sadness welled up with tremendous speed\./, "As the shock wore off, a wave of sadness hit me with terrifying speed.");
  text = text.replace(/Sadness was by far greater than anger\./, "The sadness far outweighed the anger.");
  text = text.replace(/It was a fierce sadness, with such presence that I felt I could almost touch it with my hands\./, "It was a visceral sadness, so thick I felt like I could reach out and touch it.");
  text = text.replace(/Tears overflowed endlessly from my eyes\./, "The tears wouldn't stop.");
  text = text.replace(/No matter how much I cried, there was no sign of it subsiding at all\./, "No matter how much I wept, the feeling wouldn't fade.");
  text = text.replace(/I cried, collapsing in the middle of the room without even turning on the light\./, "I collapsed in the middle of the dark room and just cried.");
  text = text.replace(/I thought of something stupid, like if these overflowing tears were oil I'd be a billionaire, and I cried again at my own stupidity\./, "I had a stupid thought—that if tears were oil, I'd be a billionaire—and then I cried even harder at how pathetic I was.");
  text = text.replace(/I want someone to help me\./, "I just wanted someone to help me.");
  text = text.replace(/I thought that with absolute sincerity\./, "I felt it with every fiber of my being.");
  text = text.replace(/But without even being able to say it out loud, all I could do was cry\./, "But I couldn't even say it out loud. All I could do was cry.");
  text = text.replace(/Even after that, it was a parade of terrible things\./, "What followed was a parade of misery.");
  text = text.replace(/This was because he and I worked at the same place, so I had to face him whether I liked it or not\./, "Since we worked together, I had to see him every day, whether I liked it or not.");
  text = text.replace(/The way he interacted with me just as usual was especially painful for me\./, "The fact that he treated me exactly the same as always was the most painful part.");
  text = text.replace(/On top of that, I frequently bumped into the woman who was his fiancée in the cafeteria or the break room\./, "I kept running into his fiancée in the cafeteria or the break room, too.");
  text = text.replace(/Whether she knew about us or not, at those times she would greet me with a bright, dazzling smile\./, "She'd always greet me with a bright smile, whether she knew about us or not.");
  text = text.replace(/Soon, my stomach completely refused to accept food, and I couldn't sleep at night\./, "Soon I couldn't eat, and I couldn't sleep.");
  text = text.replace(/My weight dropped rapidly, and though I somehow managed to disguise it with makeup, my complexion was an earthy color like a corpse's\./, "The weight fell off me. Even with makeup, my skin looked like a corpse's.");
  text = text.replace(/During work, tears would suddenly well up, and I cried many times in the restroom, stifling my voice\./, "I'd burst into tears at work and have to hide in the bathroom to cry silently.");
  text = text.replace(/After about two weeks, thinking I was at my limit both physically and mentally, I finally submitted my resignation to my boss\./, "After two weeks, I hit my breaking point and handed in my resignation.");
  text = text.replace(/On my last day of work, Hideaki cheerfully said to me, "Let's go for food again even after you quit!"/, "On my last day, Hideaki cheerfully told me, \"Let's grab dinner sometime after you quit!\"");
  text = text.replace(/Losing both my lover and my job all at once, I ended up tasting the feeling of being suddenly cast out into outer space\./, "Losing my boyfriend and my job all at once felt like being cast out into deep space.");
  text = text.replace(/I was from Kyushu, and since I had come to Tokyo for work after graduating from a local university, my acquaintances were mostly just people from the office\./, "I was from Kyushu, and since I'd only moved to Tokyo after university, most of the people I knew were from work.");
  text = text.replace(/Because I'm shy and not the type who is very good at socializing, I had absolutely no close friends in Tokyo\./, "I'm shy and not exactly a social butterfly, so I didn't have any close friends in the city.");
  text = text.replace(/Looking back, my twenty-five years of life up until then had always been "so-so\."/, "Looking back, my life up until then had always been just... \"so-so.\"");
  text = text.replace(/Born into a so-so wealthy family, graduating from a so-so good university, getting a job at a so-so good company\.\.\. I thought I'd continue to lead a so-so life forever, and I actually liked that well enough\./, "I was born into a reasonably comfortable family, went to a decent university, and got a job at a decent company. I'd expected my life to continue on that same uninspired path forever—and I was fine with that.");
  text = text.replace(/No peaks of happiness, but no rock bottoms either\./, "No great highs, but no terrible lows either.");
  text = text.replace(/That was supposed to be my life\./, "That was the life I was meant to have.");
  text = text.replace(/Meeting Hideaki was something very special for someone like me\./, "Meeting Hideaki had been something special.");
  text = text.replace(/For me, who was always passive, becoming lovers with someone I was head-over-heels in love with was nothing short of a miracle\./, "For someone as passive as me, actually being with the person I loved felt like a miracle.");
  text = text.replace(/Partly because of that, this shock was immeasurable, and I had no idea how I should deal with it at all\./, "Which was why the shock was so profound. I had no idea how to cope.");
  text = text.replace(/In the end, the coping mechanism I took was simply to sleep\./, "In the end, my only coping mechanism was sleep.");
  text = text.replace(/I was surprisingly sleepy, even to myself\./, "I was surprisingly tired, all the time.");
  text = text.replace(/Perhaps my body did that for the sake of escaping reality, but as soon as I crawled under the covers, I fell asleep\./, "Maybe it was just a way to escape reality, but as soon as I crawled under the covers, I'd drift off.");
  text = text.replace(/In my little room, a solitary pocket of space, I slept for many days\./, "I spent days sleeping in my tiny room, a solitary pocket of space.");

  return prefix + text;
};

const processFile = (segmentsPath, refinedPath) => {
  const segments = JSON.parse(readFileSync(segmentsPath, 'utf8'));
  const refined = segments.map(s => refineMorisaki(s.en));
  writeFileSync(refinedPath, JSON.stringify(refined, null, 2));
  console.log(`Refined ${refined.length} segments to ${refinedPath}`);
};

processFile('part0001_segments.json', '/Users/waylonhuang/.gemini/tmp/epub/work_morisaki/OEBPS/Text/part0001.xhtml.refined.json');
processFile('part0003_segments.json', '/Users/waylonhuang/.gemini/tmp/epub/work_morisaki/OEBPS/Text/part0003.xhtml.refined.json');
