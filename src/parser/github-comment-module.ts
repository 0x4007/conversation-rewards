import { Value } from "@sinclair/typebox/value";
import Decimal from "decimal.js";
import * as fs from "fs";
import { stringify } from "yaml";
import { CommentType } from "../configuration/comment-types";
import configuration from "../configuration/config-reader";
import { GithubCommentConfiguration, githubCommentConfigurationType } from "../configuration/github-comment-config";
import { getOctokitInstance } from "../octokit";
import { getGithubWorkflowRunUrl } from "../helpers/github-comment-module-instance";
import logger from "../helpers/logger";
import { getERC20TokenSymbol } from "../helpers/web3";
import { IssueActivity } from "../issue-activity";
import program from "./command-line";
import { GithubCommentScore, Module, Result } from "./processor";

interface SortedTasks {
  issues: { specification: GithubCommentScore | null; comments: GithubCommentScore[] };
  reviews: GithubCommentScore[];
}

/**
 * Posts a GitHub comment according to the given results.
 */
export class GithubCommentModule implements Module {
  private readonly _configuration: GithubCommentConfiguration = configuration.incentives.githubComment;
  private readonly _debugFilePath = "./output.html";
  /**
   * COMMENT_ID can be set in the environment to reference the id of the last comment created during this workflow.
   * See also compute.yml to understand how it is set.
   */
  private _lastCommentId: number | null = process.env.COMMENT_ID ? Number(process.env.COMMENT_ID) : null;

  async transform(data: Readonly<IssueActivity>, result: Result): Promise<Result> {
    const bodyArray: (string | undefined)[] = [];

    for (const [key, value] of Object.entries(result)) {
      result[key].evaluationCommentHtml = await this._generateHtml(key, value);
      bodyArray.push(result[key].evaluationCommentHtml);
    }
    // Add the workflow run url and the metadata in the GitHub's comment
    bodyArray.push("\n<!--");
    bodyArray.push(`\n${getGithubWorkflowRunUrl()}\n`);
    bodyArray.push(JSON.stringify(result, null, 2));
    bodyArray.push("\n-->");
    const body = bodyArray.join("");
    if (this._configuration.debug) {
      fs.writeFileSync(this._debugFilePath, body);
    }
    if (this._configuration.post) {
      try {
        await this.postComment(body);
      } catch (e) {
        logger.error(`Could not post GitHub comment: ${e}`);
      }
    }
    return result;
  }

  get enabled(): boolean {
    if (!Value.Check(githubCommentConfigurationType, this._configuration)) {
      logger.error("Invalid configuration detected for GithubContentModule, disabling.");
      return false;
    }
    return true;
  }

  async postComment(body: string, updateLastComment = true) {
    const { eventPayload } = program;
    if (updateLastComment && this._lastCommentId !== null) {
      await getOctokitInstance().issues.updateComment({
        body,
        repo: eventPayload.repository.name,
        owner: eventPayload.repository.owner.login,
        issue_number: eventPayload.issue.number,
        comment_id: this._lastCommentId,
      });
    } else {
      const comment = await getOctokitInstance().issues.createComment({
        body,
        repo: eventPayload.repository.name,
        owner: eventPayload.repository.owner.login,
        issue_number: eventPayload.issue.number,
      });
      this._lastCommentId = comment.data.id;
    }
  }

  _createContributionRows(result: Result[0], sortedTasks: SortedTasks | undefined) {
    const content: string[] = [];

    if (result.task?.reward) {
      content.push(buildContributionRow("Issue", "Task", result.task.multiplier, result.task.reward));
    }

    if (!sortedTasks) {
      return content.join("");
    }

    function buildContributionRow(
      view: string,
      contribution: string,
      count: number,
      reward: number | Decimal | undefined
    ) {
      return `
          <tr>
            <td>${view}</td>
            <td>${contribution}</td>
            <td>${count}</td>
            <td>${reward || "-"}</td>
          </tr>`;
    }

    if (sortedTasks.issues.specification) {
      content.push(buildContributionRow("Issue", "Specification", 1, sortedTasks.issues.specification.score?.reward));
    }
    if (sortedTasks.issues.comments.length) {
      content.push(
        buildContributionRow(
          "Issue",
          "Comment",
          sortedTasks.issues.comments.length,
          sortedTasks.issues.comments.reduce((acc, curr) => acc.add(curr.score?.reward ?? 0), new Decimal(0))
        )
      );
    }
    if (sortedTasks.reviews.length) {
      content.push(
        buildContributionRow(
          "Review",
          "Comment",
          sortedTasks.reviews.length,
          sortedTasks.reviews.reduce((acc, curr) => acc.add(curr.score?.reward ?? 0), new Decimal(0))
        )
      );
    }
    return content.join("");
  }

  _createIncentiveRows(sortedTasks: SortedTasks | undefined) {
    const content: string[] = [];

    if (!sortedTasks) {
      return content.join("");
    }

    function buildIncentiveRow(commentScore: GithubCommentScore) {
      // Properly escape carriage returns for HTML rendering
      const formatting = stringify(commentScore.score?.formatting).replace(/[\n\r]/g, "&#13;");
      // Makes sure any HTML injected in the templated is not rendered itself
      const sanitizedContent = commentScore.content
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("`", "&#96;");
      return `
          <tr>
            <td>
              <h6>
                <a href="${commentScore.url}" target="_blank" rel="noopener">${sanitizedContent.replace(/(.{64})..+/, "$1&hellip;")}</a>
              </h6>
            </td>
            <td>
            <details>
              <summary>
                ${Object.values(commentScore.score?.formatting?.content || {}).reduce((acc, curr) => {
                  const multiplier = new Decimal(
                    commentScore.score?.formatting
                      ? commentScore.score.formatting.formattingMultiplier * commentScore.score.formatting.wordValue
                      : 0
                  );
                  return acc.add(multiplier.mul(curr.score * curr.count));
                }, new Decimal(0))}
              </summary>
              <pre>${formatting}</pre>
             </details>
            </td>
            <td>${commentScore.score?.relevance || "-"}</td>
            <td>${commentScore.score?.reward || "-"}</td>
          </tr>`;
    }

    if (sortedTasks.issues.specification) {
      content.push(buildIncentiveRow(sortedTasks.issues.specification));
    }
    for (const issueComment of sortedTasks.issues.comments) {
      content.push(buildIncentiveRow(issueComment));
    }
    for (const reviewComment of sortedTasks.reviews) {
      content.push(buildIncentiveRow(reviewComment));
    }
    return content.join("");
  }

  async _generateHtml(username: string, result: Result[0]) {
    const sortedTasks = result.comments?.reduce<SortedTasks>(
      (acc, curr) => {
        if (curr.type & CommentType.ISSUE) {
          if (curr.type & CommentType.SPECIFICATION) {
            acc.issues.specification = curr;
          } else {
            acc.issues.comments.push(curr);
          }
        } else if (curr.type & CommentType.REVIEW) {
          acc.reviews.push(curr);
        }
        return acc;
      },
      { issues: { specification: null, comments: [] }, reviews: [] }
    );

    const tokenSymbol = await getERC20TokenSymbol(configuration.evmNetworkId, configuration.erc20RewardToken);

    return `
    <details>
      <summary>
        <b>
          <h3>
            <a href="${result.permitUrl}" target="_blank" rel="noopener">
              [ ${result.total} ${tokenSymbol} ]
            </a>
          </h3>
          <h6>
            @${username}
          </h6>
        </b>
      </summary>
      <h6>Contributions Overview</h6>
      <table>
        <thead>
          <tr>
            <th>View</th>
            <th>Contribution</th>
            <th>Count</th>
            <th>Reward</th>
          </tr>
        </thead>
        <tbody>
          ${this._createContributionRows(result, sortedTasks)}
        </tbody>
      </table>
      <h6>Conversation Incentives</h6>
      <table>
        <thead>
          <tr>
            <th>Comment</th>
            <th>Formatting</th>
            <th>Relevance</th>
            <th>Reward</th>
          </tr>
        </thead>
        <tbody>
          ${this._createIncentiveRows(sortedTasks)}
        </tbody>
      </table>
    </details>
    `
      .replace(/[\n\r]+/g, " ")
      .trim();
  }
}
