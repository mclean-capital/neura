export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Allow proper nouns and acronyms (e.g. "Intel", "ONNX") in subjects
    'subject-case': [0],
  },
};
