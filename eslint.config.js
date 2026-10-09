import js from '@eslint/js';
import tseslint from 'typescript-eslint';
export default tseslint.config({ignores:['dist/**','node_modules/**']},js.configs.recommended,...tseslint.configs.recommended,{files:['**/*.ts'],languageOptions:{globals:{process:'readonly',console:'readonly',setInterval:'readonly',clearInterval:'readonly'}},rules:{'@typescript-eslint/no-unused-vars':['error',{argsIgnorePattern:'^_',varsIgnorePattern:'^_'}],'@typescript-eslint/no-namespace':'off'}});
