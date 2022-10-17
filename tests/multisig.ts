/**
 * How to use
 * 1. Build the program `anchor build -- --features devnet`
 * 2. Start local validator `solana-test-validator`
 * 3. Deploy the program:
    solana program deploy\
      --program-id ./target/deploy/mean_multisig-keypair.json\
      --url localhost\
         target/deploy/mean_multisig.so
 * 4. Run tests:
    anchor test\
      --skip-local-validator\
      --skip-deploy\
      --provider.cluster localnet\
      -- --features devnet
 */
import * as anchor from "@project-serum/anchor";
import { AnchorError, AnchorProvider, BN, Program } from '@project-serum/anchor';
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { MeanMultisig } from "../target/types/mean_multisig";
import { assert, expect } from "chai";

// type Transaction = anchor.IdlAccounts<MeanMultisig>["transaction"];
type TransactionAccount = anchor.IdlTypes<MeanMultisig>["TransactionAccount"];
type Owner = anchor.IdlTypes<MeanMultisig>["Owner"];

const MEAN_MULTISIG_OPS = new PublicKey("3TD6SWY9M1mLY2kZWJNavPLhwXvcRsWdnZLRaMzERJBw");

describe("multisig", async () => {
    const provider = anchor.getProvider() as AnchorProvider;
    anchor.setProvider(provider);
    const program = anchor.workspace.MeanMultisig as Program<MeanMultisig>;
    const [settings] = await PublicKey.findProgramAddress([Buffer.from(anchor.utils.bytes.utf8.encode("settings"))], program.programId);
    const [programData] = await PublicKey.findProgramAddress([program.programId.toBytes()], new anchor.web3.PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"));

    const multisig = Keypair.generate();
    const transaction = Keypair.generate();
    const [txDetailAddress] = await PublicKey.findProgramAddress(
        [multisig.publicKey.toBuffer(), transaction.publicKey.toBuffer()],
        program.programId
    );

    const owner1Key = Keypair.generate();
    const owner2Key = Keypair.generate();
    const owner3Key = Keypair.generate();
    const nonOwnerKey = Keypair.generate();

    before(async () => {
        await fundWallet(provider, owner1Key);
        await fundWallet(provider, owner2Key);
        await fundWallet(provider, owner3Key);
        await fundWallet(provider, nonOwnerKey);

        let settingsAccount = await program.account.settings.fetch(
            settings,
            'confirmed'
        );

        if (!settingsAccount) {
            await program.methods.initSettings().accounts({
                payer: (program.provider as AnchorProvider).wallet.publicKey,
                authority: (program.provider as AnchorProvider).wallet.publicKey,
                program: program.programId,
                programData,
                settings,
                systemProgram: SystemProgram.programId,
            }).rpc();

            settingsAccount = await program.account.settings.fetch(
                settings,
                'confirmed'
            );
        }

        assert.exists(settingsAccount);
        assert.ok(settingsAccount.createMultisigFee.eq(new BN(20_000_000)));
        assert.ok(settingsAccount.createTransactionFee.eq(new BN(20_000_000)));
    });

    // xit("init settings", async () => {
    //     await program.methods.initSettings().accounts({
    //         payer: (program.provider as AnchorProvider).wallet.publicKey,
    //         authority: (program.provider as AnchorProvider).wallet.publicKey,
    //         program: program.programId,
    //         programData,
    //         settings,
    //         systemProgram: SystemProgram.programId,
    //     }).rpc();
    // });

    it("creates multisig account", async () => {

        const label = 'Test';
        const threshold = new BN(2);
        const owners = [
            {
                address: owner1Key.publicKey,
                name: "owner1"
            },
            {
                address: owner2Key.publicKey,
                name: "owner2"
            },
            {
                address: owner3Key.publicKey,
                name: "owner3"
            }
        ];

        // create multisig
        const [, nonce] = await PublicKey.findProgramAddress(
            [multisig.publicKey.toBuffer()],
            program.programId
        );

        await program.methods
            .createMultisig(owners, new BN(threshold), nonce, label)
            .accounts({
                proposer: owner1Key.publicKey,
                multisig: multisig.publicKey,
                settings,
                opsAccount: MEAN_MULTISIG_OPS,
                systemProgram: SystemProgram.programId,
            })
            .signers([owner1Key, multisig])
            .rpc();
    });

    it("creates proposal", async () => {

        // create transaction with multiple instructions
        const ix1 = SystemProgram.transfer({
            fromPubkey: provider.wallet.publicKey,
            lamports: 10 * LAMPORTS_PER_SOL,
            toPubkey: nonOwnerKey.publicKey
        });

        const txSize = 1200;
        const createIx = await program.account.transaction.createInstruction(
            transaction,
            txSize
        );

        const title = 'Test transaction';
        const description = "This is a test transaction";
        type Instruction = {
            programId: PublicKey,
            accounts: {
                pubkey: PublicKey,
                isSigner: boolean,
                isWritable: boolean,
            }[],
            data: Buffer | undefined,
        }
        const operation = 1;
        let transactionInstruction: Instruction =
        {
            programId: ix1.programId,
            accounts: ix1.keys.map(key => ({ pubkey: key.pubkey, isSigner: key.isSigner, isWritable: key.isWritable })),
            data: ix1.data
        };

        await program.methods
            .createTransaction(
                ix1.programId,
                ix1.keys.map(key => ({ pubkey: key.pubkey, isSigner: key.isSigner, isWritable: key.isWritable })),
                ix1.data,
                operation,
                title,
                description,
                new BN((new Date().getTime() / 1000) + 3600),
                new BN(0),
                255
            )
            .preInstructions([createIx])
            .accounts({
                multisig: multisig.publicKey,
                transaction: transaction.publicKey,
                transactionDetail: txDetailAddress,
                proposer: owner1Key.publicKey,
                settings,
                opsAccount: MEAN_MULTISIG_OPS,
                systemProgram: SystemProgram.programId,
            })
            .signers([transaction, owner1Key])
            .rpc({
                commitment: 'confirmed',
            });
    });

    it("approves proposal (1 out of 2 needed)", async () => {
        await program.methods
            .approve()
            .accounts({
                multisig: multisig.publicKey,
                transaction: transaction.publicKey,
                transactionDetail: txDetailAddress,
                owner: owner1Key.publicKey,
                systemProgram: SystemProgram.programId,
            })
            .signers([owner1Key])
            .rpc(
                {
                    commitment: 'confirmed',
                }
            );
    });

    it("fails to approve by non onwer", async () => {
        await program.methods
            .approve()
            .accounts({
                multisig: multisig.publicKey,
                transaction: transaction.publicKey,
                transactionDetail: txDetailAddress,
                owner: owner1Key.publicKey,
                systemProgram: SystemProgram.programId,
            })
            .signers([owner1Key])
            .rpc(
                {
                    commitment: 'confirmed',
                }
            );
    });

    it("fails to execute proposal when not enough approvals", async () => {
        const txAccount = await program.account.transaction.fetch(
            transaction.publicKey,
            'confirmed'
        );

        const [multisigSigner] = await PublicKey.findProgramAddress(
            [multisig.publicKey.toBuffer()],
            program.programId
        );

        let remainingAccounts: {
            pubkey: PublicKey;
            isSigner: boolean;
            isWritable: boolean;
        }[] = (txAccount.accounts as TransactionAccount[])
            // Change the signer status on the vendor signer since it's signed by the program, not the client.
            .map((meta) =>
                meta.pubkey.equals(multisigSigner)
                    ? { ...meta, isSigner: false }
                    : meta
            )
            .concat({
                pubkey: txAccount.programId,
                isWritable: false,
                isSigner: false,
            });

        let expectedError: AnchorError | null = null;

        try {

            await program.methods
                .executeTransaction()
                .accounts({
                    multisig: multisig.publicKey,
                    multisigSigner: multisigSigner,
                    transaction: transaction.publicKey,
                    transactionDetail: txDetailAddress,
                    payer: nonOwnerKey.publicKey,
                    systemProgram: SystemProgram.programId,
                })
                .signers([nonOwnerKey]) // anyone can execute once it reaches the approval threshold
                .remainingAccounts(remainingAccounts)
                .rpc(
                    {
                        commitment: 'confirmed',
                    }
                );
        } catch (error) {
            // console.log(error);
            expectedError = error as AnchorError;
        }
        assert.isNotEmpty(expectedError);
        assert.equal(expectedError?.error.errorCode.code, 'NotEnoughSigners');
        assert.equal(expectedError?.error.errorCode.number, 6002);
        assert.equal(expectedError?.error.errorMessage, 'Not enough owners signed this transaction.');
    });

    it("approves proposal (2 out of 2 needed)", async () => {
        await program.methods
            .approve()
            .accounts({
                multisig: multisig.publicKey,
                transaction: transaction.publicKey,
                transactionDetail: txDetailAddress,
                owner: owner2Key.publicKey,
                systemProgram: SystemProgram.programId,
            })
            .signers([owner2Key])
            .rpc(
                {
                    commitment: 'confirmed',
                }
            );
    });

    it("rejects proposal", async () => {
        await program.methods
            .reject()
            .accounts({
                multisig: multisig.publicKey,
                transaction: transaction.publicKey,
                transactionDetail: txDetailAddress,
                owner: owner3Key.publicKey,
                systemProgram: SystemProgram.programId,
            })
            .signers([owner3Key])
            .rpc(
                {
                    commitment: 'confirmed',
                }
            );
    });

    it("executes proposal", async () => {
        const txAccount = await program.account.transaction.fetch(
            transaction.publicKey,
            'confirmed'
        );

        const [multisigSigner] = await PublicKey.findProgramAddress(
            [multisig.publicKey.toBuffer()],
            program.programId
        );

        let remainingAccounts: {
            pubkey: PublicKey;
            isSigner: boolean;
            isWritable: boolean;
        }[] = (txAccount.accounts as TransactionAccount[])
            // Change the signer status on the vendor signer since it's signed by the program, not the client.
            .map((meta) =>
                meta.pubkey.equals(multisigSigner)
                    ? { ...meta, isSigner: false }
                    : meta
            )
            .concat({
                pubkey: txAccount.programId,
                isWritable: false,
                isSigner: false,
            });

        const balanceBefore = await program.provider.connection
            .getBalance(nonOwnerKey.publicKey, 'confirmed');

        await program.methods
            .executeTransaction()
            .accounts({
                multisig: multisig.publicKey,
                multisigSigner: multisigSigner,
                transaction: transaction.publicKey,
                transactionDetail: txDetailAddress,
                payer: nonOwnerKey.publicKey,
                systemProgram: SystemProgram.programId,
            })
            .signers([nonOwnerKey]) // anyone can execute once it reaches the approval threshold
            .remainingAccounts(remainingAccounts)
            .rpc(
                {
                    commitment: 'confirmed',
                }
            );

        const balanceAfter = await program.provider.connection
            .getBalance(nonOwnerKey.publicKey, 'confirmed');
        const balanceIncrement = balanceAfter - balanceBefore;
        assert.equal(
            balanceIncrement,
            10_000_000_000,
            `incorrect balance after to ${nonOwnerKey.publicKey} transfer proposal executed`
        );
    });
});

describe("multisig2", async () => {
    const provider = anchor.getProvider() as AnchorProvider;
    anchor.setProvider(provider);
    const program = anchor.workspace.MeanMultisig as Program<MeanMultisig>;
    const [settings] = await PublicKey.findProgramAddress([Buffer.from(anchor.utils.bytes.utf8.encode("settings"))], program.programId);

    it("tests the multisig program", async () => {
        const multisig = anchor.web3.Keypair.generate();
        const [multisigSigner, nonce] =
            await anchor.web3.PublicKey.findProgramAddress(
                [multisig.publicKey.toBuffer()],
                program.programId
            );
        const [settings] = await PublicKey.findProgramAddress([Buffer.from(anchor.utils.bytes.utf8.encode("settings"))], program.programId);

        const ownerA = anchor.web3.Keypair.generate();
        const ownerB = anchor.web3.Keypair.generate();
        const ownerC = anchor.web3.Keypair.generate();
        const ownerD = anchor.web3.Keypair.generate();
        const owners2 = [
            {
                address: ownerA.publicKey,
                name: "ownerA"
            },
            {
                address: ownerB.publicKey,
                name: "ownerB"
            },
            {
                address: ownerC.publicKey,
                name: "ownerC"
            }
        ];

        await fundWallet(provider, ownerA);

        const threshold = new anchor.BN(2);

        await program.methods
            .createMultisig(owners2, new BN(threshold), nonce, "Safe2")
            .accounts({
                proposer: ownerA.publicKey,
                multisig: multisig.publicKey,
                settings: settings,
                opsAccount: MEAN_MULTISIG_OPS,
                systemProgram: SystemProgram.programId,
            })
            .signers([ownerA, multisig])
            .rpc();

        let multisigAccount = await program.account.multisigV2.fetch(
            multisig.publicKey
        );
        assert.strictEqual(multisigAccount.nonce, nonce);
        assert.ok(multisigAccount.threshold.eq(new anchor.BN(2)));
        let fetchedOwners = multisigAccount.owners as Owner[];
        assert.ok(fetchedOwners[0].address.equals(ownerA.publicKey));
        assert.ok(fetchedOwners[1].address.equals(ownerB.publicKey));
        assert.ok(fetchedOwners[2].address.equals(ownerC.publicKey));
        assert.ok(multisigAccount.ownerSetSeqno === 0);

        const pid = program.programId;
        const accounts = [
            {
                pubkey: multisig.publicKey,
                isWritable: true,
                isSigner: false,
            },
            {
                pubkey: multisigSigner,
                isWritable: false,
                isSigner: true,
            },
        ];
        const newOwners = [
            {
                address: ownerA.publicKey,
                name: "ownerA"
            },
            {
                address: ownerB.publicKey,
                name: "ownerB"
            },
            {
                address: ownerD.publicKey,
                name: "ownerD"
            }
        ];
        const data = program.coder.instruction.encode("edit_multisig", {
            owners: newOwners,
            threshold: new BN(2),
            label: "Safe2.1"
        });

        const transaction = anchor.web3.Keypair.generate();
        const txSize = 1000; // Big enough, cuz I'm lazy.

        const [txDetailAddress] = await PublicKey.findProgramAddress(
            [multisig.publicKey.toBuffer(), transaction.publicKey.toBuffer()],
            program.programId
        );

        await program.methods
            .createTransaction(
                pid,
                accounts,
                data,
                1,
                "Update owners",
                "Update owners",
                new BN((new Date().getTime() / 1000) + 3600),
                new BN(0),
                255
            )
            .preInstructions(
                [
                    await program.account.transaction.createInstruction(
                        transaction,
                        txSize
                    )
                ])
            .accounts({
                multisig: multisig.publicKey,
                transaction: transaction.publicKey,
                transactionDetail: txDetailAddress,
                proposer: ownerA.publicKey,
                settings: settings,
                opsAccount: MEAN_MULTISIG_OPS,
                systemProgram: SystemProgram.programId,
            })
            .signers([transaction, ownerA])
            .rpc({
                commitment: 'confirmed',
            });

        let txAccount = await program.account.transaction.fetch(
            transaction.publicKey
        );

        assert.ok(txAccount.programId.equals(pid));
        assert.deepStrictEqual(txAccount.accounts, accounts);
        assert.deepStrictEqual(txAccount.data, data);
        assert.ok(txAccount.multisig.equals(multisig.publicKey));
        assert.ok(txAccount.executedOn.eq(new BN(0)));
        assert.ok(txAccount.ownerSetSeqno === 0);

        // Other owner approves transaction.
        await program.methods
            .approve()
            .accounts({
                multisig: multisig.publicKey,
                transaction: transaction.publicKey,
                transactionDetail: txDetailAddress,
                owner: ownerB.publicKey,
                systemProgram: SystemProgram.programId,
            })
            .signers([ownerB])
            .rpc(
                {
                    commitment: 'confirmed',
                }
            );

        // Now that we've reached the threshold, send the transactoin.

        let remainingAccounts2 = [
            {
                pubkey: multisig.publicKey,
                isWritable: true,
                isSigner: false,
            },
            {
                pubkey: multisigSigner,
                isWritable: false,
                isSigner: false,
            },
            {
                pubkey: txAccount.programId,
                isWritable: false,
                isSigner: false,
            },
        ];
        // Or we can do:
        // let remainingAccounts2: {
        //     pubkey: PublicKey;
        //     isSigner: boolean;
        //     isWritable: boolean;
        // }[] = (txAccount2.accounts as TransactionAccount[])
        //     // Change the signer status on the vendor signer since it's signed by the program, not the client.
        //     .map((meta) =>
        //         meta.pubkey.equals(multisigSigner2)
        //             ? { ...meta, isSigner: false }
        //             : meta
        //     )
        //     .concat({
        //         pubkey: txAccount2.programId,
        //         isWritable: false,
        //         isSigner: false,
        //     });

        const randomExecutor = Keypair.generate();

        await program.methods
            .executeTransaction()
            .accounts({
                multisig: multisig.publicKey,
                multisigSigner: multisigSigner,
                transaction: transaction.publicKey,
                transactionDetail: txDetailAddress,
                payer: randomExecutor.publicKey,
                systemProgram: SystemProgram.programId,
            })
            .signers([randomExecutor]) // anyone can execute once it reaches the approval threshold
            .remainingAccounts(remainingAccounts2)
            .rpc(
                {
                    commitment: 'confirmed',
                }
            );

        multisigAccount = await program.account.multisigV2.fetch(multisig.publicKey);

        txAccount = await program.account.transaction.fetch(
            transaction.publicKey
        );

        assert.strictEqual(multisigAccount.nonce, nonce);
        assert.ok(multisigAccount.threshold.eq(new anchor.BN(2)));
        fetchedOwners = multisigAccount.owners as Owner[];
        assert.ok(fetchedOwners[0].address.equals(ownerA.publicKey));
        assert.ok(fetchedOwners[1].address.equals(ownerB.publicKey));
        assert.ok(fetchedOwners[2].address.equals(ownerD.publicKey));
        assert.ok(multisigAccount.ownerSetSeqno === 1);
        assert.ok(txAccount.executedOn.gt(new BN(0)));
    });

    it("assert unique owners", async () => {
        const multisig = anchor.web3.Keypair.generate();
        const ownerA = anchor.web3.Keypair.generate();
        const ownerB = anchor.web3.Keypair.generate();
        const owners = [
            {
                address: ownerA.publicKey,
                name: "ownerA"
            },
            {
                address: ownerB.publicKey,
                name: "ownerB"
            },
            {
                address: ownerA.publicKey,
                name: "ownerA"
            }
        ];

        await fundWallet(provider, ownerA);

        const threshold = new anchor.BN(2);
        try {
            // create multisig
            const [, nonce] = await PublicKey.findProgramAddress(
                [multisig.publicKey.toBuffer()],
                program.programId
            );

            await program.methods
                .createMultisig(owners, new BN(threshold), nonce, "Safe3")
                .accounts({
                    proposer: ownerA.publicKey,
                    multisig: multisig.publicKey,
                    settings,
                    opsAccount: MEAN_MULTISIG_OPS,
                    systemProgram: SystemProgram.programId,
                })
                .signers([ownerA, multisig])
                .rpc();
            assert.fail();
        } catch (err) {
            const error = (err as AnchorError).error;
            assert.strictEqual(error.errorCode.number, 6009);
            assert.strictEqual(error.errorMessage, "Owners must be unique.");
        }
    });
});

async function fundWallet(provider: AnchorProvider, userKey: Keypair) {
    const tx = new Transaction();
    tx.add(SystemProgram.transfer({
        fromPubkey: provider.wallet.publicKey,
        lamports: 1000 * LAMPORTS_PER_SOL,
        toPubkey: userKey.publicKey
    }));
    await provider.sendAndConfirm(tx);
};

function sleep(ms: number) {
    console.log('Sleeping for', ms / 1000, 'seconds');
    return new Promise((resolve) => setTimeout(resolve, ms));
}