/**
 * A long stored answer with three cited sentences far apart — the shape the
 * anchored classifier produces in production (up to three anchors spread
 * over the whole answer). Every quote is an exact raw slice.
 */
import type { SentimentEvidence } from "@workspace/lib/sentiment";

const FILLER_A =
	"Rechtsschutzversicherungen unterscheiden sich vor allem bei Wartezeiten, Selbstbeteiligung und den versicherten Lebensbereichen. " +
	"Wer Privat-, Berufs- und Verkehrsrechtsschutz kombiniert, sollte auf Ausschlüsse im Kleingedruckten achten und die Bedingungen für bereits laufende Streitigkeiten prüfen. ";
const FILLER_B =
	"Auch die Erreichbarkeit der Hotline, die Qualität der telefonischen Erstberatung und die Dauer der Schadenregulierung sind im Alltag entscheidend. " +
	"Vergleichsportale bewerten diese Punkte unterschiedlich, weshalb sich ein Blick in mehrere Tests lohnt. ";

export const FIRST = "**Arvo Aktiv Komfort** – umfassender Schutz mit guter Erstberatung.";
export const SECOND = "Stärken liegen unter anderem bei Familienrecht, Dokumentenprüfung und Kapitalanlagen.";
export const THIRD =
	"Sinnvoll, wenn dir ein besonders breiter Leistungsumfang wichtiger ist als der niedrigste Beitrag.";

/** Three cited sentences, each separated by well over 2 × EXCERPT_RADIUS (160) characters of filler. */
export const LONG_ANSWER = `${FIRST}\n\n${FILLER_A}${FILLER_A}${SECOND}\n\n${FILLER_B}${FILLER_B}${FILLER_A}${THIRD}\n\n${FILLER_B}`;

function span(quote: string, polarity: SentimentEvidence["polarity"]): SentimentEvidence {
	const start = LONG_ANSWER.indexOf(quote);
	if (start === -1) throw new Error("fixture quote missing");
	return { quote, start, end: start + quote.length, polarity };
}

export const THREE_DISTANT_SPANS: SentimentEvidence[] = [
	span(FIRST, "positive"),
	span(SECOND, "positive"),
	span(THIRD, "negative"),
];
