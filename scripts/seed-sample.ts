/**
 * Seed the CPC (Bulgarian Commission for Protection of Competition) database
 * with sample decisions, mergers, and sectors for testing.
 *
 * Usage:
 *   npx tsx scripts/seed-sample.ts
 *   npx tsx scripts/seed-sample.ts --force
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

const DB_PATH = process.env["CPC_BG_DB_PATH"] ?? "data/cpc-bg.db";
const force = process.argv.includes("--force");

const dir = dirname(DB_PATH);
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
if (force && existsSync(DB_PATH)) { unlinkSync(DB_PATH); console.log(`Deleted existing database at ${DB_PATH}`); }

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(SCHEMA_SQL);
console.log(`Database initialised at ${DB_PATH}`);

const sectors = [
  { id: "telecommunications", name: "Телекомуникации", name_en: "Telecommunications", description: "Мобилни услуги, широколентов интернет, фиксирана телефония и телекомуникационна инфраструктура.", decision_count: 3, merger_count: 2 },
  { id: "energy", name: "Енергетика", name_en: "Energy", description: "Електроснабдяване, газоснабдяване, разпределителни мрежи и търговия с енергия.", decision_count: 2, merger_count: 1 },
  { id: "retail", name: "Търговия на дребно", name_en: "Retail", description: "Хранителни стоки, верижни магазини и онлайн търговия.", decision_count: 2, merger_count: 1 },
  { id: "financial_services", name: "Финансови услуги", name_en: "Financial services", description: "Банки, застрахователи, платежни услуги и капиталови пазари.", decision_count: 1, merger_count: 1 },
  { id: "digital_economy", name: "Цифрова икономика", name_en: "Digital economy", description: "Онлайн платформи, електронна търговия, цифрови услуги и данни.", decision_count: 2, merger_count: 0 },
  { id: "media", name: "Медии", name_en: "Media", description: "Телевизионно и радио излъчване, онлайн медии и рекламен пазар.", decision_count: 1, merger_count: 1 },
];

const is = db.prepare("INSERT OR IGNORE INTO sectors (id, name, name_en, description, decision_count, merger_count) VALUES (?, ?, ?, ?, ?, ?)");
for (const s of sectors) is.run(s.id, s.name, s.name_en, s.description, s.decision_count, s.merger_count);
console.log(`Inserted ${sectors.length} sectors`);

const decisions = [
  { case_number: "КЗК-1234/2023", title: "Мобилтел / А1 — злоупотреба с господстващо положение на пазара на мобилни услуги", date: "2023-06-15", type: "abuse_of_dominance", sector: "telecommunications", parties: JSON.stringify(["А1 България ЕАД"]), summary: "КЗК установи злоупотреба с господстващо положение от страна на А1 България на пазара на мобилни телекомуникационни услуги чрез въвеждане на ценови условия, ограничаващи конкуренцията при предлагане на пакетни услуги.", full_text: "КЗК образува производство по отношение на А1 България ЕАД по подозрение за злоупотреба с господстващо положение по чл. 21 от ЗЗК. А1 заема господстващо положение на пазара на мобилни телекомуникационни услуги в България с пазарен дял над 35%. Установено е, че дружеството е въвело ценови условия за пакетни услуги, при които абонатите, преминаващи към конкурент, понасят несъразмерни неустойки. КЗК констатира, че тази практика ограничава конкуренцията и затруднява смяната на доставчик от потребителите. На А1 е наложена имуществена санкция и предписание за преустановяване на нарушението и привеждане на договорните условия в съответствие с конкурентното право.", outcome: "fine", fine_amount: 2_850_000, gwb_articles: JSON.stringify(["21", "38"]), status: "final" },
  { case_number: "КЗК-0892/2022", title: "Лидл България / Разследване на координирани ценови практики в хранителната търговия", date: "2022-11-08", type: "cartel", sector: "retail", parties: JSON.stringify(["Лидл България ЕООД", "Кауфланд България ЕООД", "Билла България ЕООД"]), summary: "КЗК разследва координирани ценови практики между водещи вериги хранителни магазини, засягащи ценообразуването при основни хранителни стоки.", full_text: "КЗК образува производство срещу три водещи вериги хранителни магазини по подозрение за нарушение на чл. 15 от ЗЗК — споразумения или съгласувани практики, ограничаващи конкуренцията. По данни от проверките е установено, че представители на дружествата са разменяли информация за планирани ценови промени при основни хранителни категории. КЗК не намери достатъчно доказателства за формален картел, но издаде предписания за преустановяване на обмена на чувствителна търговска информация. Случаят подчертава значението на информационната хигиена в секторите с концентриран пазарен дял.", outcome: "cleared_with_conditions", fine_amount: null, gwb_articles: JSON.stringify(["15", "34"]), status: "final" },
  { case_number: "КЗК-0567/2023", title: "Топлофикация София / Злоупотреба при топлоснабдяване", date: "2023-03-20", type: "abuse_of_dominance", sector: "energy", parties: JSON.stringify(["Топлофикация София ЕАД"]), summary: "КЗК установи злоупотреба с господстващо положение от страна на Топлофикация София чрез налагане на несправедливи търговски условия за абонати в регулирани жилищни сгради.", full_text: "КЗК образува производство срещу Топлофикация София ЕАД като естествен монополист в сектора на топлоснабдяването в столицата. Установено е, че дружеството е прилагало методология за разпределение на топлоенергия, водеща до несправедливи сметки за потребителите в многофамилни сгради. Допълнително са установени нарушения при условията за достъп на независими дружества за разпределение. КЗК издаде задължително предписание за промяна на методологията и наложи административна санкция.", outcome: "fine", fine_amount: 1_200_000, gwb_articles: JSON.stringify(["21", "22"]), status: "final" },
  { case_number: "КЗК-0334/2022", title: "Google / Онлайн търсачка и конкуренция на пазара на дигиталната реклама в България", date: "2022-07-14", type: "abuse_of_dominance", sector: "digital_economy", parties: JSON.stringify(["Google LLC", "Google Ireland Limited"]), summary: "КЗК разследва практиките на Google на пазара за онлайн реклама в България, свързани с предимствено позициониране на собствени услуги в резултати от търсенето.", full_text: "КЗК образува производство срещу Google по подозрение за злоупотреба с господстващо положение на пазара за онлайн търсене и свързаните с него рекламни пазари в България. Разследването обхваща предимственото позициониране на Google Shopping и Google Maps в резултатите от търсенето за сметка на конкурентни услуги. КЗК координира действията си с Европейската комисия предвид паралелното разследване на ниво ЕС. Производството е прекратено след поемане на задължения от Google за промяна на практиките в съответствие с решенията на ЕК.", outcome: "cleared_with_conditions", fine_amount: null, gwb_articles: JSON.stringify(["21", "101"]), status: "final" },
  { case_number: "КЗК-0102/2024", title: "Сектор на телекомуникациите — Секторно проучване", date: "2024-02-28", type: "sector_inquiry", sector: "telecommunications", parties: JSON.stringify(["А1 България ЕАД", "Теленор България ЕАД", "Виваком"]), summary: "КЗК публикува резултатите от секторното проучване на пазара на мобилни телекомуникационни услуги, установяващо структурни проблеми с конкуренцията.", full_text: "КЗК завърши секторното проучване на пазара на мобилни телекомуникационни услуги в България. Установени са следните проблеми: (1) Висока пазарна концентрация — тримата оператора А1, Теленор и Виваком контролират 98% от пазара; (2) Ниска мобилност на клиентите поради сложни процедури за пренасяне на номер; (3) Липса на прозрачност при тарифните условия за роуминг. КЗК отправи препоръки към регулатора КРС за засилване на надзора и опростяване на процедурите за смяна на оператор.", outcome: "cleared", fine_amount: null, gwb_articles: JSON.stringify(["26"]), status: "final" },
];

const id = db.prepare("INSERT OR IGNORE INTO decisions (case_number, title, date, type, sector, parties, summary, full_text, outcome, fine_amount, gwb_articles, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
db.transaction(() => { for (const d of decisions) id.run(d.case_number, d.title, d.date, d.type, d.sector, d.parties, d.summary, d.full_text, d.outcome, d.fine_amount, d.gwb_articles, d.status); })();
console.log(`Inserted ${decisions.length} decisions`);

const mergers = [
  { case_number: "КЗК-М-0421/2023", title: "Телекомуникационна компания / Придобиване на доставчик на интернет услуги", date: "2023-09-11", sector: "telecommunications", acquiring_party: "А1 България ЕАД", target: "Нет Сервиз ЕООД", summary: "КЗК одобри в Фаза 1 придобиването на доставчик на интернет услуги от А1 България, след като установи, че сделката не поражда значителни конкурентни проблеми на националния пазар.", full_text: "КЗК разгледа нотификацията за концентрация, при която А1 България придобива 100% от дяловете на Нет Сервиз ЕООД — регионален доставчик на интернет услуги в Южна България. А1 и целевото дружество имат ограничено географско припокриване на пазарите за широколентов интернет. КЗК установи, че придобиването не би довело до значително ограничаване на конкуренцията на национален или регионален пазар и одобри сделката без условия в рамките на Фаза 1.", outcome: "cleared_phase1", turnover: 450_000_000 },
  { case_number: "КЗК-М-0187/2023", title: "Финансова група / Придобиване на застрахователно дружество", date: "2023-04-25", sector: "financial_services", acquiring_party: "ДСК Груп АД", target: "Evroins Ins AD", summary: "КЗК одобри с условия придобиването на застрахователно дружество от водеща банкова група, изисквайки структурни мерки на застрахователния пазар.", full_text: "КЗК разгледа концентрацията между ДСК Груп и Evroins. ДСК е водеща банкова група в България с клонова мрежа от над 300 офиса. Придобиването на застрахователно дружество би позволило разпространение на застрахователни продукти чрез банковата мрежа. КЗК идентифицира конкурентни проблеми при банкозастраховането — съвместното разпространение на банкови и застрахователни продукти може да затрудни достъпа на конкурентни застрахователи до клиенти. Сделката е одобрена при условие, че ДСК не задължава клиентите да избират Evroins при ипотечни или потребителски кредити.", outcome: "cleared_with_conditions", turnover: 2_100_000_000 },
  { case_number: "КЗК-М-0634/2022", title: "Медийна група / Придобиване на регионални медии", date: "2022-12-19", sector: "media", acquiring_party: "Нова Броудкастинг Груп ЕАД", target: "Булгариан Медия Груп АД", summary: "КЗК одобри в Фаза 1 придобиването на регионална медийна група, установявайки ограничено припокриване на медийните пазари в засегнатите региони.", full_text: "КЗК разгледа придобиването на Булгариан Медия Груп от Нова Броудкастинг Груп. Нова Броудкастинг оперира национален телевизионен канал и онлайн медии. Целевото дружество притежава регионални радиостанции и онлайн портали. КЗК анализира припокриването на рекламните пазари и аудиторията и установи, че страните оперират предимно в различни сегменти на медийния пазар. Придобиването е одобрено без условия в рамките на Фаза 1.", outcome: "cleared_phase1", turnover: 180_000_000 },
];

const im = db.prepare("INSERT OR IGNORE INTO mergers (case_number, title, date, sector, acquiring_party, target, summary, full_text, outcome, turnover) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
db.transaction(() => { for (const m of mergers) im.run(m.case_number, m.title, m.date, m.sector, m.acquiring_party, m.target, m.summary, m.full_text, m.outcome, m.turnover); })();
console.log(`Inserted ${mergers.length} mergers`);

const dCount = (db.prepare("SELECT count(*) as cnt FROM decisions").get() as { cnt: number }).cnt;
const mCount = (db.prepare("SELECT count(*) as cnt FROM mergers").get() as { cnt: number }).cnt;
const sCount = (db.prepare("SELECT count(*) as cnt FROM sectors").get() as { cnt: number }).cnt;
console.log(`\nDatabase summary:\n  Sectors:   ${sCount}\n  Decisions: ${dCount}\n  Mergers:   ${mCount}\n\nDone. Database ready at ${DB_PATH}`);
db.close();
