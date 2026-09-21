// ── Franchises and the characters that name them ─────────────────────────────
//
// A suggestion list, not a registry: normalizeListing proposes a franchise and
// a character from a title, and the admin confirms or corrects both in review.
// Order matters. The first entry whose alias appears wins, so a narrow
// franchise sits above a broad one ("Astro Bot" before "PlayStation").
//
// An alias must be safe as a whole word in any product title. Generic words
// ("luna", "friends", "toad", "sonic" on its own) are left out on purpose,
// and so are characters whose names are ordinary words (Penguin, Robin, Link,
// Boo, Mew, Eleven, Goofy): a penguin mug is not DC Comics. A wrong suggestion
// costs the admin more than a missing one.
//
// `nameMatches: false` is for a franchise whose own name is an ordinary word
// ("Best Friends Mug" is not Friends, a bleach joke is not Bleach): it is
// found only through its aliases and characters.

export const FRANCHISES = Object.freeze([
  { name: 'Astro Bot', aliases: ['astro bot', 'astrobot'], characters: [] },
  { name: 'Pokemon', aliases: ['pokemon'], characters: ['Pikachu', 'Eevee', 'Charmander', 'Bulbasaur', 'Squirtle', 'Gengar', 'Snorlax', 'Jigglypuff', 'Psyduck', 'Mewtwo', 'Lapras', 'Magikarp', 'Gyarados', 'Charizard'] },
  { name: 'Sailor Moon', aliases: ['sailor moon'], characters: ['Chibiusa'] },
  { name: 'South Park', aliases: ['south park'], characters: ['Kenny McCormick', 'Eric Cartman', 'Cartman', 'Kyle Broflovski', 'Stan Marsh'] },
  { name: 'Star Wars', aliases: ['star wars', 'mandalorian'], characters: ['Grogu', 'Baby Yoda', 'Yoda', 'Darth Vader', 'Stormtrooper', 'Chewbacca', 'Ewok', 'R2-D2', 'C-3PO', 'Boba Fett', 'Din Djarin', 'Princess Leia', 'Han Solo', 'Kylo Ren'] },
  { name: 'DC Comics', aliases: ['dc comics', 'justice league'], characters: ['Batman', 'Joker', 'Superman', 'Wonder Woman', 'Harley Quinn', 'Aquaman', 'Catwoman', 'Two-Face', 'Riddler'] },
  { name: 'Marvel', aliases: ['marvel', 'avengers', 'x-men'], characters: ['Spider-Man', 'Iron Man', 'Captain America', 'Thor', 'Hulk', 'Groot', 'Deadpool', 'Venom', 'Wolverine', 'Loki', 'Black Panther', 'Thanos', 'Rocket Raccoon'] },
  { name: 'Harry Potter', aliases: ['harry potter', 'hogwarts', 'fantastic beasts'], characters: ['Hedwig', 'Dobby', 'Hagrid', 'Gryffindor', 'Slytherin', 'Hufflepuff', 'Ravenclaw', 'Sorting Hat', 'Niffler'] },
  { name: 'Disney', aliases: ['disney', 'pixar', 'toy story', 'lion king', 'winnie the pooh'], characters: ['Mickey Mouse', 'Minnie Mouse', 'Stitch', 'Donald Duck', 'Buzz Lightyear', 'Simba', 'Eeyore', 'Tigger', 'Olaf'] },
  { name: 'Super Mario', aliases: ['super mario', 'mario kart', 'mario bros'], characters: ['Mario', 'Luigi', 'Bowser', 'Yoshi', 'Princess Peach', 'Wario'] },
  { name: 'The Legend of Zelda', aliases: ['legend of zelda', 'zelda', 'hyrule', 'triforce'], characters: ['Ganondorf', 'Korok'] },
  { name: 'Kirby', aliases: ['kirby'], characters: [] },
  { name: 'Animal Crossing', aliases: ['animal crossing'], characters: ['Tom Nook'] },
  { name: 'Sonic the Hedgehog', aliases: ['sonic the hedgehog'], characters: ['Dr Eggman'] },
  { name: 'PlayStation', aliases: ['playstation'], characters: [] },
  { name: 'Dragon Ball', aliases: ['dragon ball', 'dragonball'], characters: ['Goku', 'Vegeta', 'Shenron'] },
  { name: 'One Piece', aliases: ['one piece'], characters: ['Luffy', 'Zoro'] },
  { name: 'Naruto', aliases: ['naruto'], characters: ['Kakashi', 'Sasuke', 'Itachi'] },
  { name: 'Demon Slayer', aliases: ['demon slayer'], characters: ['Tanjiro', 'Nezuko'] },
  { name: 'Jujutsu Kaisen', aliases: ['jujutsu kaisen'], characters: ['Gojo'] },
  { name: 'My Hero Academia', aliases: ['my hero academia'], characters: ['Deku', 'All Might'] },
  { name: 'Attack on Titan', aliases: ['attack on titan'], characters: ['Eren'] },
  { name: 'Chainsaw Man', aliases: ['chainsaw man'], characters: ['Pochita'] },
  { name: 'Studio Ghibli', aliases: ['studio ghibli', 'ghibli', 'my neighbor totoro', 'spirited away'], characters: ['Totoro', 'No-Face', 'Jiji', 'Calcifer'] },
  { name: 'Hello Kitty', aliases: ['hello kitty', 'sanrio'], characters: ['Kuromi', 'My Melody', 'Cinnamoroll', 'Pompompurin'] },
  { name: 'The Simpsons', aliases: ['simpsons'], characters: ['Homer Simpson', 'Bart Simpson', 'Lisa Simpson'] },
  { name: 'Rick and Morty', aliases: ['rick and morty'], characters: ['Pickle Rick'] },
  { name: 'Stranger Things', aliases: ['stranger things'], characters: ['Demogorgon'] },
  { name: 'The Lord of the Rings', aliases: ['lord of the rings', 'the hobbit'], characters: ['Gandalf', 'Gollum', 'Frodo', 'Sauron'] },
  { name: 'Game of Thrones', aliases: ['game of thrones', 'house of the dragon'], characters: [] },
  { name: 'Star Trek', aliases: ['star trek'], characters: ['Spock'] },
  { name: 'Minecraft', aliases: ['minecraft'], characters: ['Enderman'] },
  { name: 'Jurassic Park', aliases: ['jurassic park', 'jurassic world'], characters: [] },
  { name: 'Ghostbusters', aliases: ['ghostbusters'], characters: ['Slimer', 'Stay Puft'] },
  { name: 'The Nightmare Before Christmas', aliases: ['nightmare before christmas'], characters: ['Jack Skellington', 'Oogie Boogie'] },
  { name: 'Beetlejuice', aliases: ['beetlejuice'], characters: [] },
  { name: 'Looney Tunes', aliases: ['looney tunes'], characters: ['Bugs Bunny', 'Daffy Duck', 'Tweety', 'Taz'] },
  { name: 'Scooby-Doo', aliases: ['scooby-doo', 'scooby doo'], characters: [] },
  { name: 'Teenage Mutant Ninja Turtles', aliases: ['ninja turtles', 'tmnt'], characters: [] },
  { name: 'Transformers', aliases: ['transformers'], characters: ['Optimus Prime', 'Megatron'] },
  { name: 'Fallout', aliases: ['fallout'], characters: ['Vault Boy'] },
  { name: 'The Witcher', aliases: ['the witcher', 'witcher'], characters: [] },
  { name: 'Halo', nameMatches: false, aliases: ['master chief', 'halo infinite'], characters: [] },
  { name: 'Pac-Man', aliases: ['pac-man', 'pacman'], characters: [] },
  { name: 'Dungeons & Dragons', aliases: ['dungeons & dragons', 'dungeons and dragons'], characters: ['Beholder'] },
  { name: 'The Office', nameMatches: false, aliases: ['dunder mifflin'], characters: [] },
  { name: 'Death Note', aliases: ['death note'], characters: ['Ryuk', 'Misa Amane'] },
  { name: 'Junji Ito', aliases: ['junji ito', 'uzumaki', 'tomie'], characters: [] },
  { name: 'Hatsune Miku', aliases: ['hatsune miku', 'vocaloid'], characters: [] },
  { name: 'Hunter x Hunter', aliases: ['hunter x hunter'], characters: ['Killua', 'Gon Freecss', 'Hisoka'] },
  { name: 'Berserk', nameMatches: false, aliases: ['berserk manga'], characters: ['Griffith'] },
  { name: 'Dan Da Dan', aliases: ['dan da dan', 'dandadan'], characters: ['Okarun'] },
  { name: 'Solo Leveling', aliases: ['solo leveling'], characters: ['Sung Jinwoo'] },
  { name: 'The Legend of Vox Machina', aliases: ['vox machina', 'critical role'], characters: [] },
  { name: 'Spy x Family', aliases: ['spy x family', 'spy family'], characters: ['Anya Forger'] },
  { name: "JoJo's Bizarre Adventure", aliases: ["jojo's bizarre adventure", 'jojos bizarre adventure'], characters: [] },
  { name: 'Bleach', nameMatches: false, aliases: ['bleach anime'], characters: ['Ichigo Kurosaki'] },
  { name: 'Neon Genesis Evangelion', aliases: ['evangelion'], characters: [] },
  { name: 'Gundam', aliases: ['gundam'], characters: [] },
  { name: 'Cowboy Bebop', aliases: ['cowboy bebop'], characters: ['Spike Spiegel'] },
  { name: 'Fullmetal Alchemist', aliases: ['fullmetal alchemist'], characters: [] },
  { name: 'Haikyu!!', aliases: ['haikyu'], characters: [] },
  { name: 'Frieren', aliases: ['frieren'], characters: [] },
  { name: 'Final Fantasy', aliases: ['final fantasy'], characters: ['Chocobo', 'Moogle'] },
  { name: 'Kingdom Hearts', aliases: ['kingdom hearts'], characters: [] },
  { name: 'Assassin\'s Creed', aliases: ["assassin's creed", 'assassins creed'], characters: [] },
  { name: 'Resident Evil', aliases: ['resident evil'], characters: [] },
  { name: 'Street Fighter', aliases: ['street fighter'], characters: [] },
  { name: 'Crash Bandicoot', aliases: ['crash bandicoot'], characters: [] },
  { name: 'Peanuts', nameMatches: false, aliases: [], characters: ['Snoopy', 'Charlie Brown'] },
  { name: 'Garfield', aliases: ['garfield'], characters: [] },
  { name: 'Friends', nameMatches: false, aliases: ['central perk'], characters: [] },
]);

// Folded, for nameKey: franchise words say which shelf a mug sits on, not
// which mug it is, so they leave the key.
export const FRANCHISE_ALIASES = Object.freeze(
  FRANCHISES.flatMap((f) => [...f.aliases, ...(f.nameMatches === false ? [] : [f.name.toLowerCase()])])
    .map((a) => a.normalize('NFKD').replace(/\p{M}/gu, ''))
    .sort((a, b) => b.length - a.length),
);
