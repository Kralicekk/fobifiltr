// Sdílené nastavení: kategorie fobií, neutrální popisy a výchozí volby.
// Načítá ho content script, popup i offscreen dokument s AI modelem.
// Popisy (prompts) jsou anglicky, protože model CLIP rozumí jen angličtině.
self.FOBI = {
  CATEGORIES: [
    {
      id: 'spiders',
      label: 'Pavouci',
      prompts: ['a photo of a spider', 'a close-up photo of a spider', 'a tarantula', 'a spider on a web'],
    },
    {
      id: 'snakes',
      label: 'Hadi',
      prompts: ['a photo of a snake', 'a close-up photo of a snake', 'a snake slithering on the ground', 'a python or a cobra'],
    },
    {
      id: 'insects',
      label: 'Hmyz a švábi',
      prompts: ['a photo of an insect', 'a cockroach', 'a centipede', 'a swarm of bugs'],
    },
    {
      id: 'rodents',
      label: 'Myši a krysy',
      prompts: ['a photo of a rat', 'a photo of a mouse, the rodent'],
    },
    {
      id: 'holes',
      label: 'Shluky děr (trypofobie)',
      prompts: ['a lotus seed pod', 'a cluster of small holes', 'skin with many small holes'],
    },
    {
      id: 'clowns',
      label: 'Klauni',
      prompts: ['a photo of a clown', 'a creepy clown face'],
    },
    {
      id: 'needles',
      label: 'Jehly a injekce',
      prompts: ['a syringe with a needle', 'an injection into the arm'],
    },
    {
      id: 'blood',
      label: 'Krev a zranění',
      prompts: ['blood', 'a bloody wound', 'a gory injury'],
    },
    {
      id: 'sharks',
      label: 'Žraloci',
      prompts: ['a photo of a shark', 'a shark swimming underwater'],
    },
  ],

  // Běžné scény. Model mezi nimi a fobiemi volí, takže čím víc běžných věcí
  // tu je, tím méně falešných poplachů (krab místo pavouka, lano místo hada).
  NEUTRAL: [
    'a photo of a person', 'a person talking to the camera', 'a group of people',
    'a close-up of a human face', 'a hand holding an object', 'a photo of a room interior',
    'a city street', 'a landscape with trees', 'the sky with clouds', 'a photo of food',
    'a car', 'a computer screen with text', 'a video game screenshot', 'a cartoon drawing',
    'a black screen', 'a blurry photo', 'a dog', 'a cat', 'a bird', 'a fish', 'a lizard',
    'a crab', 'a crab on the sand', 'a ghost crab', 'a small crab walking on the beach', 'a lobster', 'a rope', 'a knot tied in a rope',
    'an electric cable', 'a tree branch', 'a garden hose', 'a plate of pasta', 'a flower',
    'green leaves of a plant', 'a toy', 'a logo', 'a document with text', 'a sports match',
  ],

  // Jak velkou pravděpodobnost musí kategorie mít, aby se scéna skryla.
  SENSITIVITY: { low: 0.55, medium: 0.35, high: 0.2 },

  DEFAULTS: {
    enabled: true,
    categories: ['spiders', 'snakes'],
    custom: [],
    sensitivity: 'medium',
    strict: true,
    mute: false,
  },
};
