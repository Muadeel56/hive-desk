import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function widgetKey() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Two fully isolated tenants, each with one ADMIN agent and one conversation.
 * Idempotent-ish: wipes the demo tenants by name first so re-runs stay clean.
 */
async function main() {
  const demoNames = ['Acme Support (demo A)', 'Globex Support (demo B)'];
  await prisma.tenant.deleteMany({ where: { name: { in: demoNames } } });

  const password = 'password123';
  const passwordHash = await bcrypt.hash(password, 10);

  const tenants = [];
  for (const [i, name] of demoNames.entries()) {
    const letter = i === 0 ? 'a' : 'b';
    const tenant = await prisma.tenant.create({
      data: {
        name,
        widgetApiKey: widgetKey(),
        settings: { welcomeMessage: `Hi from ${name}!`, brandColor: '#2563eb' },
        agents: {
          create: {
            email: `admin@tenant-${letter}.test`,
            passwordHash,
            name: `Admin ${letter.toUpperCase()}`,
            role: 'ADMIN',
          },
        },
        conversations: {
          create: { visitorSessionId: crypto.randomUUID(), status: 'AI' },
        },
      },
      include: { agents: true, conversations: true },
    });
    tenants.push(tenant);
  }

  console.log('\nSeeded 2 isolated tenants:\n');
  for (const t of tenants) {
    console.log(`  ${t.name}`);
    console.log(`    tenantId       : ${t.id}`);
    console.log(`    widgetApiKey   : ${t.widgetApiKey}`);
    console.log(`    agent login    : ${t.agents[0].email} / ${password}`);
    console.log(`    conversationId : ${t.conversations[0].id}\n`);
  }
  console.log('Use these to reproduce the Phase 1 cross-tenant isolation check (see README).\n');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
