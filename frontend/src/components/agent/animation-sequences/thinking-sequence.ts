export const generateThinkingSequence = (rows: number, columns: number) => {
  const seq = [];
  const y = Math.floor(rows / 2);
  for (let x = 0; x < columns; x++) {
    seq.push({ x, y });
  }
  for (let x = columns - 1; x >= 0; x--) {
    seq.push({ x, y });
  }

  return seq;
};

export const generateThinkingSequenceBar = (columns: number) => {
  const seq = [];
  for (let x = 0; x < columns; x++) {
    seq.push(x);
  }

  for (let x = columns - 1; x >= 0; x--) {
    seq.push(x);
  }

  return seq;
};

export const generateThinkingSequenceRadialBar = (columns: number) => {
  const seq = [];
  for (let x = 0; x < columns; x++) {
    seq.push(x);
  }

  return seq;
};
