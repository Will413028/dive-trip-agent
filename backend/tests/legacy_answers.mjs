import { acceptedAnswerSchema } from '../../src/domain/answer.ts';
import { compileAnswer } from '../../src/agent/answer-compiler.ts';

let input = '';
for await (const chunk of process.stdin) input += chunk;
process.stdout.write(JSON.stringify(JSON.parse(input).map(({ plan, context, actual }) => {
  acceptedAnswerSchema.parse(actual);
  return compileAnswer(plan, context);
})));
