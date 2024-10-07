import {
  ApolloClient,
  InMemoryCache,
  gql,
  createHttpLink,
} from '@apollo/client';
import { setContext } from '@apollo/client/link/context';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { promptTemplate } from './prompt';
import { typeDefs } from './typeDefs';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const APPSYNC_ENDPOINT = process.env.APPSYNC_ENDPOINT;
const APPSYNC_API_KEY = process.env.APPSYNC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL;
const BEDROCK_MODEL = process.env.BEDROCK_MODEL || 'anthropic.claude-3-sonnet-20240229-v1:0';

const bedrockClient = new BedrockRuntimeClient({ region: 'us-east-1' });

const httpLink = createHttpLink({
  uri: APPSYNC_ENDPOINT,
});

const authLink = setContext((_, { headers }) => {
  return {
    headers: {
      ...headers,
      'x-api-key': APPSYNC_API_KEY,
    },
  };
});

const apolloClient = new ApolloClient({
  link: authLink.concat(httpLink),
  cache: new InMemoryCache(),
  typeDefs: typeDefs,
});

enum TaskStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  ERROR = 'ERROR',
}

const UPDATE_TASK_MUTATION_WITH_DISTILLED_TASK = gql`
  mutation UpdateTask($id: ID!, $status: TaskStatus!, $distilledTask: String) {
    updateTask(id: $id, status: $status, distilledTask: $distilledTask) {
      id
      owner
      originalPrompt
      distilledTask
      status
    }
  }
`;

const UPDATE_TASK_MUTATION = gql`
  mutation UpdateTask($id: ID!, $status: TaskStatus!) {
    updateTask(id: $id, status: $status) {
      id
      owner
      originalPrompt
      distilledTask
      status
    }
  }
`;

export const lambdaHandler = async (event: any): Promise<void> => {
  console.log(event);
  const { taskId, originalPrompt } = event;

  try {
    console.log(
      `Updating AppSync with taskId: ${taskId} and status: PROCESSING`,
    );
    const processingResponse = await apolloClient.mutate({
      mutation: UPDATE_TASK_MUTATION,
      variables: {
        id: taskId,
        status: TaskStatus.PROCESSING,
      },
    });
    console.log(
      `Processing Response: ${JSON.stringify(processingResponse, null, 2)}`,
    );

    const updatedTaskPrompt = promptTemplate.replace(
      '{{ORIGINAL_PROMPT}}',
      originalPrompt,
    );
    console.log(`Updated Task Prompt: ${updatedTaskPrompt}`);

    const input = {
      modelId: BEDROCK_MODEL,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        messages: [
          { role: 'user', content: updatedTaskPrompt },
          { role: 'assistant', content: 'Here is the distilled task:' },
        ],
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 8192,
        temperature: 0,
      }),
    };

    const command = new InvokeModelCommand(input);
    const response = await bedrockClient.send(command);

    console.log(response);
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    console.log('responseBody');
    console.log(responseBody);

    const distilledTask = extractDistilledTask(responseBody.content[0].text);
    console.log(`Distilled Task: \n${JSON.stringify(distilledTask, null, 2)}`);

    console.log(
      `Updating AppSync with taskId: ${taskId} and status: COMPLETED`,
    );
    const completedResponse = await apolloClient.mutate({
      mutation: UPDATE_TASK_MUTATION_WITH_DISTILLED_TASK,
      variables: {
        id: taskId,
        status: TaskStatus.COMPLETED,
        distilledTask: distilledTask,
      },
    });
    console.log(
      `Completed Response: ${JSON.stringify(completedResponse, null, 2)}`,
    );
  } catch (error) {
    console.error('Error distilling task:', error);
    // Update the status to "ERROR" if an error occurs during task distillation
    await apolloClient.mutate({
      mutation: UPDATE_TASK_MUTATION,
      variables: {
        id: taskId,
        status: TaskStatus.ERROR,
      },
    });
  }
};

function extractDistilledTask(fullText: string): string {

  const newPromptMatch = fullText.match(
    /<new_prompt>([\s\S]*?)<\/new_prompt>/,
  );
  if (newPromptMatch && newPromptMatch[1]) {
    return newPromptMatch[1].trim();
  }
  throw new Error('No <new_prompt> tags found in the response');

}
